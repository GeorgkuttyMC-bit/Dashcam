export const uploadToDrive = async (accessToken: string, blob: Blob, filename: string) => {
  const metadata = {
    name: filename,
    mimeType: blob.type || 'video/webm',
  };

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload to Drive: ${response.statusText}`);
  }

  return response.json();
};
