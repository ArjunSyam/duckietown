import {
  Folder,
  FolderOpen,
  FileText,
  FileSpreadsheet,
  Presentation,
  Image as ImageIcon,
  Video,
  Music,
  Archive,
  FileCode2,
  Package,
  Box,
  Database,
  Settings,
  Terminal,
  Type as FontGlyph,
  type LucideIcon,
} from "lucide-react";

// One folder per broad category under src/assets/filetypes/, SVGs named
// by extension (documents/pdf.svg, images/png.svg) or, for the handful of
// conventional no-extension filenames, by the full lowercased name
// (devops/dockerfile.svg, devops/makefile.svg). Glob import picks up
// whatever's actually on disk, however deep — an empty/missing folder
// just resolves to {} rather than erroring, so nothing breaks before any
// icons exist.
//
// Loaded as raw text (not a URL) and recolored below: the catalogued set
// is monochrome, with fill/stroke baked in as #000000. An <img src> can't
// be recolored by page CSS at all (no currentColor across that boundary),
// and CSS mask-image only preserves alpha — these icons layer an opaque
// stroke-only accent shape (e.g. Docker's container outline, a folder
// fold) on top of an already-opaque page silhouette, so a flat alpha mask
// has no opaque/transparent boundary left to show the accent at all; it
// just reads as one solid blob. Swapping the literal black paint for
// `currentColor` and rendering the real markup inline preserves the
// actual layered artwork, recolored via ordinary CSS `color`.
const svgRawModules = import.meta.glob("../assets/filetypes/**/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

function recolorable(raw: string): string {
  return raw
    .replace(/width="[^"]*"/, 'width="100%"')
    .replace(/height="[^"]*"/, 'height="100%"')
    .replace(/(fill|stroke)="#000(?:000)?"/gi, '$1="currentColor"')
    .replace(/(fill|stroke)="black"/gi, '$1="currentColor"');
}

export type Category =
  | "3d-cad"
  | "archives"
  | "audio"
  | "code"
  | "config"
  | "data"
  | "devops"
  | "documents"
  | "executables"
  | "fonts"
  | "generic"
  | "images"
  | "other"
  | "presentations"
  | "spreadsheets"
  | "video";

const CATEGORIES = new Set<Category>([
  "3d-cad", "archives", "audio", "code", "config", "data", "devops",
  "documents", "executables", "fonts", "generic", "images", "other",
  "presentations", "spreadsheets", "video",
]);

function isCategory(s: string): s is Category {
  return CATEGORIES.has(s as Category);
}

// Built once at module load from whatever *.svg files actually exist.
const extToSvg = new Map<string, string>();
const extToCategory = new Map<string, Category>();

const PATH_RE = /filetypes\/([^/]+)\/([^/]+)\.svg$/;
for (const [path, raw] of Object.entries(svgRawModules)) {
  const match = PATH_RE.exec(path);
  if (!match) continue;
  const [, category, rawName] = match;
  const key = rawName.toLowerCase();
  extToSvg.set(key, recolorable(raw));
  if (isCategory(category)) extToCategory.set(key, category);
}

const CATEGORY_META: Record<Category, { Icon: LucideIcon; color: string; label: string }> = {
  "3d-cad": { Icon: Box, color: "#f472b6", label: "3D Model" },
  archives: { Icon: Archive, color: "#fbbf24", label: "Archive" },
  audio: { Icon: Music, color: "#34d399", label: "Audio" },
  code: { Icon: FileCode2, color: "#f472b6", label: "Source File" },
  config: { Icon: Settings, color: "#94a3b8", label: "Config File" },
  data: { Icon: Database, color: "#4ade80", label: "Data File" },
  devops: { Icon: Terminal, color: "#60a5fa", label: "DevOps File" },
  documents: { Icon: FileText, color: "#f87171", label: "Document" },
  executables: { Icon: Terminal, color: "#fb923c", label: "Executable" },
  fonts: { Icon: FontGlyph, color: "#c084fc", label: "Font" },
  generic: { Icon: Package, color: "#6b7280", label: "File" },
  images: { Icon: ImageIcon, color: "#7dd3fc", label: "Image" },
  other: { Icon: Package, color: "#6b7280", label: "File" },
  presentations: { Icon: Presentation, color: "#fb923c", label: "Presentation" },
  spreadsheets: { Icon: FileSpreadsheet, color: "#4ade80", label: "Spreadsheet" },
  video: { Icon: Video, color: "#a78bfa", label: "Video" },
};

// A handful of extensions keep their previously-shipped, more specific
// label instead of the generic "{EXT} {Category}" pattern.
const SPECIAL_LABELS: Record<string, string> = {
  pdf: "PDF Document",
  doc: "Word Document",
  docx: "Word Document",
  xls: "Excel Spreadsheet",
  xlsx: "Excel Spreadsheet",
  csv: "CSV Document",
  ppt: "PowerPoint Presentation",
  pptx: "PowerPoint Presentation",
  txt: "Text Document",
  md: "Markdown Document",
};

// "report.pdf" -> "pdf"; ".gitignore" -> "gitignore"; "Dockerfile" / and
// other conventional no-extension filenames -> their full lowercased name,
// which is exactly how this icon set names them.
function ext(name: string): string {
  const lower = name.toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx > 0) return lower.slice(dotIdx + 1);
  if (dotIdx === 0) return lower.slice(1);
  return lower;
}

/** Works with mime="" too (the AI panel only ever has a filename). */
export function fileTypeKey(mime: string, name: string): Category {
  const cat = extToCategory.get(ext(name));
  if (cat) return cat;
  // No catalogued icon for this name — fall back to mime sniffing.
  if (mime.startsWith("image/")) return "images";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.includes("spreadsheet")) return "spreadsheets";
  if (mime.includes("presentation")) return "presentations";
  if (mime.includes("pdf") || mime.includes("document") || mime.includes("text"))
    return "documents";
  return "generic";
}

export function isImageType(mime: string, name: string): boolean {
  if (extToCategory.get(ext(name)) === "images") return true;
  return mime.startsWith("image/");
}

/** Human "Kind" column text, e.g. "PDF Document", "MP4 Video". */
export function kindLabel(mime: string, name: string): string {
  const e = ext(name);
  if (SPECIAL_LABELS[e]) return SPECIAL_LABELS[e];
  const label = CATEGORY_META[fileTypeKey(mime, name)].label;
  return e ? `${e.toUpperCase()} ${label}` : label;
}

interface FileTypeIconProps {
  name?: string;
  mime?: string;
  folder?: boolean;
  /** Only meaningful when folder=true — use the open-folder variant. */
  open?: boolean;
  size?: number;
  className?: string;
}

// Muted neutral, in the same family as the app's border/divider gray —
// deliberately not a saturated accent color like the file-type categories,
// so folders read as structural chrome rather than "a kind of file."
const FOLDER_COLOR = "#8a8a90";

function InlineIcon({
  svg,
  color,
  size,
  className,
}: {
  svg: string;
  color: string;
  size: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-hidden
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        color,
      }}
      // Safe: svg content is our own bundled assets (glob-imported from
      // src/assets/filetypes at build time), never user/runtime input.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function FileTypeIcon({
  name = "",
  mime = "",
  folder = false,
  open = false,
  size = 28,
  className,
}: FileTypeIconProps) {
  if (folder) {
    const svg = extToSvg.get(open ? "folder-open" : "folder");
    if (svg) {
      return <InlineIcon svg={svg} color={FOLDER_COLOR} size={size} className={className} />;
    }
    const Icon = open ? FolderOpen : Folder;
    return (
      <Icon
        size={size}
        strokeWidth={1.4}
        style={{ color: FOLDER_COLOR }}
        className={className}
      />
    );
  }

  const { Icon, color } = CATEGORY_META[fileTypeKey(mime, name)];
  const svg = extToSvg.get(ext(name));
  if (svg) {
    return <InlineIcon svg={svg} color={color} size={size} className={className} />;
  }

  return (
    <Icon size={size} strokeWidth={1.4} style={{ color }} className={className} />
  );
}
