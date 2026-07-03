// Shared image helpers used by StorageService, the drive connectors, and the
// library service. Content-addressing images by SHA-256 of the data URI means
// "same image" checks never need byte comparison or re-uploads.

export const hashDataUri = async (dataUri: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUri));
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
};

export const dataUriToBlob = (dataUri: string): Blob => {
    const [header, base64] = dataUri.split(',');
    const mime = /data:(.*?);base64/.exec(header)?.[1] || 'application/octet-stream';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
};

export const blobToDataUri = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
