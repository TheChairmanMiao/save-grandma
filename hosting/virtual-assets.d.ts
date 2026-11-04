declare module 'virtual:save-grandma-assets' {
  const assets: Record<string, {
    contentType: string;
    byteLength: number;
    etag: string;
    encoding: 'utf8' | 'base64';
    body: string;
  }>;
  export default assets;
}
