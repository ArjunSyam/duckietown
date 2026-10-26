// Builds a direct URL to a file already synced into the local vault,
// served by the Go backend's asset-server middleware (see
// internal/vault/httpserve.go) — no Wails IPC call, no network fetch.
// `<img src>` can point straight at this, same as any static asset.
export function vaultFileUrl(name: string, folderPath: string): string {
  const relPath = folderPath ? `${folderPath}/${name}` : name;
  const encoded = relPath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/vaultfile/${encoded}`;
}
