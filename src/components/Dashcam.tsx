import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Camera, StopCircle, Cloud, CloudOff, AlertTriangle, Activity, Navigation, UploadCloud, CheckCircle, Map as MapIcon } from 'lucide-react';
import { User } from 'firebase/auth';
import { initAuth, googleSignIn, getAccessToken, logout } from '../lib/firebase';
import { uploadToDrive } from '../lib/drive';
import { APIProvider, Map, AdvancedMarker, useMap } from '@vis.gl/react-google-maps';

// Configure segment length (e.g. 15 seconds for testing, usually 60-180 in real dashcams)
const SEGMENT_DURATION_MS = 15000;
const INCIDENT_THRESHOLD_G = 2.5;
const MAPS_API_KEY = (import.meta as any).env.VITE_MAPS_API_KEY || 'AIzaSyMapsDemoKey'; // Fallback to demo key if not provided

function RoutePolyline({ path }: { path: { lat: number; lng: number }[] }) {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map || !window.google) return;
    if (!polylineRef.current) {
      polylineRef.current = new window.google.maps.Polyline({
        map,
        strokeColor: '#3b82f6',
        strokeOpacity: 0.8,
        strokeWeight: 4,
      });
    }
    polylineRef.current.setPath(path);
  }, [map, path]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
      }
    };
  }, []);

  return null;
}

export default function Dashcam() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const incidentDetectedRef = useRef<boolean>(false);

  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speed, setSpeed] = useState<number>(0);
  const [gForce, setGForce] = useState<number>(1.0);
  const [incidentCount, setIncidentCount] = useState<number>(0);
  
  const [routeCoords, setRouteCoords] = useState<{lat: number, lng: number}[]>([]);
  const [currentLocation, setCurrentLocation] = useState<{lat: number, lng: number} | null>(null);

  const [user, setUser] = useState<User | null>(null);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [permissionError, setPermissionError] = useState<string>('');

  // Setup Auth
  useEffect(() => {
    const unsubscribe = initAuth(
      (u) => {
        setUser(u);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setNeedsAuth(false);
      }
    } catch (err) {
      console.error('Login failed:', err);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const requestPermissions = async () => {
    try {
      // 1. Camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: true
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // 2. Geolocation
      if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(
          (position) => {
            // speed is in m/s, convert to mph (1 m/s = 2.23694 mph)
            const speedMph = (position.coords.speed || 0) * 2.23694;
            setSpeed(speedMph);
            const newPoint = { lat: position.coords.latitude, lng: position.coords.longitude };
            setCurrentLocation(newPoint);
            setRouteCoords(prev => [...prev, newPoint]);
          },
          (err) => console.warn('Geolocation error:', err),
          { enableHighAccuracy: true, maximumAge: 1000 }
        );
      }

      // 3. Motion (iOS requires explicit permission request)
      if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        const permissionState = await (DeviceMotionEvent as any).requestPermission();
        if (permissionState === 'granted') {
          window.addEventListener('devicemotion', handleMotion);
        }
      } else {
        window.addEventListener('devicemotion', handleMotion);
      }

      setPermissionsGranted(true);
    } catch (err: any) {
      console.error('Permission error:', err);
      setPermissionError(err.message || 'Permission denied. If you are in a preview window, try opening the app in a new tab.');
    }
  };

  const handleMotion = useCallback((event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (acc && acc.x != null && acc.y != null && acc.z != null) {
      // Calculate magnitude in Gs (1G = ~9.81 m/s^2)
      const magnitude = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z) / 9.81;
      setGForce(magnitude);
      
      if (magnitude > INCIDENT_THRESHOLD_G && !incidentDetectedRef.current) {
         incidentDetectedRef.current = true;
         setIncidentCount(c => c + 1);
         setUploadStatus('Incident detected! Forcing save...');
      }
    }
  }, []);

  const saveAndUploadSegment = async (blob: Blob, hasIncident: boolean) => {
    if (!blob || blob.size === 0) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = hasIncident ? 'INCIDENT' : 'LOOP';
    const filename = `DashCam_${prefix}_${timestamp}.webm`;

    // Always keep a local copy download option if not logged in, but for dashcams
    // automatic cloud is preferred. Let's upload if user is logged in.
    const token = getAccessToken();
    if (token) {
      setUploadStatus(`Uploading ${filename}...`);
      try {
        await uploadToDrive(token, blob, filename);
        setUploadStatus('Upload complete');
        setTimeout(() => setUploadStatus(''), 3000);
      } catch (err) {
        console.error('Upload failed', err);
        setUploadStatus('Upload failed');
      }
    } else {
      // Fallback: trigger download for incident only, or just ignore standard loops to not spam downloads
      if (hasIncident) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
    }
  };

  const startSegment = () => {
    incidentDetectedRef.current = false;
    
    if (!streamRef.current) {
      // Mock recording behavior in Preview mode
      segmentTimerRef.current = window.setTimeout(() => {
        startSegment(); // Fake loop
      }, SEGMENT_DURATION_MS);
      return;
    }
    
    // We use MediaRecorder
    const options = { mimeType: 'video/webm;codecs=vp9,opus' };
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(streamRef.current, options);
    } catch (e) {
      recorder = new MediaRecorder(streamRef.current); // fallback to default
    }
    
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      const hadIncident = incidentDetectedRef.current;
      saveAndUploadSegment(blob, hadIncident);
    };

    recorder.start();
    mediaRecorderRef.current = recorder;

    // Schedule next segment
    segmentTimerRef.current = window.setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
        // Immediately start next segment if still "isRecording"
        startSegment();
      }
    }, SEGMENT_DURATION_MS);
  };

  const toggleRecording = () => {
    if (isRecording) {
      // Stop
      setIsRecording(false);
      if (segmentTimerRef.current) clearTimeout(segmentTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    } else {
      // Start
      setIsRecording(true);
      startSegment();
    }
  };

  if (!permissionsGranted) {
    return (
      <div className="min-h-screen bg-neutral-900 text-white flex flex-col items-center justify-center p-6 text-center">
        <Camera className="w-16 h-16 text-blue-500 mb-6" />
        <h1 className="text-3xl font-bold mb-4 tracking-tight">DashCam Cloud</h1>
        <p className="text-neutral-400 max-w-md mb-8 text-lg">
          Convert your phone into a smart dash camera with loop recording, real-time G-sensor incident detection, speed tracking, and automatic Google Drive backups.
        </p>

        {permissionError && (
          <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl mb-6 max-w-md flex flex-col items-center">
            <AlertTriangle className="w-6 h-6 mb-2" />
            <p className="text-sm font-semibold mb-1">Camera Access Denied</p>
            <p className="text-xs text-red-300 text-center mb-3">{permissionError}</p>
            <p className="text-xs font-medium text-red-200 bg-red-950/50 p-2 rounded mb-4 text-center">
              💡 Tip: If you are using the AI Studio preview, click the "Open in new tab" icon (↗) in the top right corner of the preview window to grant permissions properly.
            </p>
            <button
              onClick={() => setPermissionsGranted(true)}
              className="bg-neutral-800 hover:bg-neutral-700 text-white text-sm font-medium py-2 px-6 rounded-full transition-colors border border-neutral-600"
            >
              Continue in Preview Mode (No Camera)
            </button>
          </div>
        )}

        <button
          onClick={requestPermissions}
          className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-8 rounded-full transition-colors flex items-center gap-3 text-lg"
        >
          <Navigation className="w-6 h-6" />
          {permissionError ? 'Try Again' : 'Grant Permissions & Start'}
        </button>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden select-none">
      {/* Video Background */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-cover"
      />
      {!streamRef.current && (
         <div className="absolute inset-0 w-full h-full object-cover bg-neutral-900 flex flex-col items-center justify-center text-neutral-600">
           <Camera className="w-24 h-24 opacity-20 mb-4" />
           <span className="text-sm font-semibold opacity-50">Preview Mode Active (No Camera)</span>
         </div>
      )}

      {/* Mini-map Overlay */}
      <div className="absolute top-24 left-4 sm:left-6 w-32 h-32 sm:w-48 sm:h-48 rounded-2xl overflow-hidden border border-white/20 shadow-xl bg-black/80 backdrop-blur-md z-10 pointer-events-none">
        <APIProvider apiKey={MAPS_API_KEY}>
          <Map
            defaultZoom={16}
            center={currentLocation || { lat: 37.7749, lng: -122.4194 }}
            disableDefaultUI={true}
            gestureHandling="none"
            mapId="DEMO_MAP_ID"
            internalUsageAttributionIds={['gmp_git_agentskills_v1', 'gmp_mcp_codeassist_v1_aistudio']}
          >
            {routeCoords.length > 1 && (
              <RoutePolyline path={routeCoords} />
            )}
            {currentLocation && (
              <AdvancedMarker position={currentLocation}>
                 <div className="w-4 h-4 bg-blue-500 rounded-full border-2 border-white shadow-[0_0_10px_rgba(59,130,246,0.8)]" />
              </AdvancedMarker>
            )}
          </Map>
        </APIProvider>
      </div>

      {/* Top Bar Overlay */}
      <div className="absolute top-0 inset-x-0 p-4 sm:p-6 flex justify-between items-start bg-gradient-to-b from-black/70 to-transparent">
        <div className="flex flex-col gap-2">
          {/* Recording Status */}
          <div className="flex items-center gap-2">
            <div className={`w-4 h-4 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-neutral-500'}`} />
            <span className="text-white font-semibold text-lg drop-shadow-md">
              {isRecording ? 'REC' : 'STBY'}
            </span>
          </div>
          {/* Upload Status */}
          {uploadStatus && (
            <div className="flex items-center gap-2 text-sm text-blue-300 bg-black/40 px-2 py-1 rounded">
              <UploadCloud className="w-4 h-4" />
              {uploadStatus}
            </div>
          )}
        </div>

        {/* Auth / Drive Sync Status */}
        <div>
          {needsAuth ? (
            <button
              onClick={handleLogin}
              disabled={isLoggingIn}
              className="bg-white text-black font-semibold py-2 px-4 rounded-full flex items-center gap-2 hover:bg-neutral-200 transition text-sm"
            >
              <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-4 h-4" alt="Google" />
              {isLoggingIn ? 'Connecting...' : 'Sync to Drive'}
            </button>
          ) : (
            <div className="flex items-center gap-3 bg-black/50 backdrop-blur-md border border-white/10 rounded-full py-1.5 px-3">
              <img src={user?.photoURL || ''} alt="User" className="w-8 h-8 rounded-full" />
              <div className="flex flex-col">
                <span className="text-white text-xs font-medium truncate max-w-[100px]">{user?.displayName}</span>
                <span className="text-emerald-400 flex items-center gap-1 text-[10px] font-bold tracking-wider">
                  <CheckCircle className="w-3 h-3" /> DRIVE SYNC ON
                </span>
              </div>
              <button onClick={logout} className="ml-2 text-neutral-400 hover:text-white transition p-1">
                <StopCircle className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Dashboard Overlay */}
      <div className="absolute bottom-0 inset-x-0 p-6 bg-gradient-to-t from-black/90 via-black/50 to-transparent flex flex-col gap-6">
        
        {/* Telemetry Row */}
        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col items-center justify-center bg-black/40 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <span className="text-neutral-400 text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-1">
              <Navigation className="w-3 h-3" /> Speed
            </span>
            <div className="flex items-baseline gap-1">
              <span className="text-white text-4xl font-black">{Math.round(speed)}</span>
              <span className="text-neutral-300 text-sm font-semibold">mph</span>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center bg-black/40 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <span className="text-neutral-400 text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-1">
              <Activity className="w-3 h-3" /> G-Force
            </span>
            <div className="flex items-baseline gap-1">
              <span className={`text-4xl font-black ${gForce > INCIDENT_THRESHOLD_G ? 'text-red-500' : 'text-white'}`}>
                {gForce.toFixed(1)}
              </span>
              <span className="text-neutral-300 text-sm font-semibold">G</span>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center bg-black/40 backdrop-blur-md rounded-2xl p-4 border border-white/10">
            <span className="text-neutral-400 text-xs font-bold uppercase tracking-widest mb-1 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> Incidents
            </span>
            <span className="text-white text-4xl font-black">{incidentCount}</span>
          </div>
        </div>

        {/* Controls Row */}
        <div className="flex justify-center items-center pb-4">
          <button
            onClick={toggleRecording}
            className={`w-20 h-20 rounded-full flex items-center justify-center border-4 transition-all ${
              isRecording 
                ? 'bg-red-500/20 border-red-500 text-red-500 hover:bg-red-500/30' 
                : 'bg-white border-white text-black hover:bg-neutral-200 hover:scale-105'
            }`}
          >
            {isRecording ? (
              <div className="w-8 h-8 bg-red-500 rounded-sm" />
            ) : (
              <div className="w-8 h-8 bg-red-500 rounded-full ml-1" />
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
