/** Human-readable size, matching the server formatting. */
export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

/**
 * Uploads through XHR instead of fetch so multi-gigabyte transfers can report
 * real progress and surface the server's own error message.
 */
export function uploadSignedFile({
  url,
  fields,
  file,
  fileName,
  onProgress,
}: {
  url: string;
  fields: Record<string, string>;
  file: Blob;
  fileName?: string;
  onProgress?: (percent: number) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields ?? {})) form.append(key, value);
    if (fileName) form.append("file", file, fileName);
    else form.append("file", file);

    const request = new XMLHttpRequest();
    request.open("POST", url, true);
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error("Соединение прервалось во время загрузки"));
    request.onabort = () => reject(new Error("Загрузка отменена"));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(100);
        resolve();
        return;
      }
      let message = `Не удалось загрузить файл (${request.status})`;
      try {
        const payload = JSON.parse(request.responseText) as { error?: { message?: string } };
        if (payload.error?.message) message = payload.error.message;
      } catch {
        // Keep the generic message when the body is not JSON.
      }
      reject(new Error(message));
    };
    request.send(form);
  });
}
