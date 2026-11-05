export interface FileRecord {
  id?: string;
  name: string;
  size: number;
  mime_type: string;
  folder_path: string; // "" = root, "work" = inside work/, "work/invoices" = nested
  created_at: string;
  updated_at: string;
  storage_path: string;
}

export interface FolderRecord {
  path: string; // relative from vault root e.g. "work/invoices"
  name: string; // last segment e.g. "invoices"
  parent: string; // parent path e.g. "work", "" for root-level folders
  children: number; // number of direct subfolders
}

export type ViewMode = "grid" | "list";

export type FileTypeFilter =
  | "all"
  | "images"
  | "documents"
  | "videos"
  | "audio"
  | "other";

export interface WailsFileEvent {
  event_type: "created" | "modified" | "deleted";
  file_name: string;
  path?: string;
  folder?: string;
}

export interface SearchResult {
  file_name: string;
  similarity: number;
  snippet: string;
  modality: string;
  page: string;
  // Added by the shared search_files tool — optional so older cached
  // responses / the type itself stay backward compatible.
  score?: number;
  folder_path?: string;
  mime_type?: string;
  summary?: string;
  category?: string;
}

export interface OrganiseResult {
  folder_name: string;
  files: string[];
  created: boolean;
  error?: string;
}

export interface BackfillResult {
  enriched: number;
  skipped: number;
  failed: number;
}

// ── Chat tool-calling ───────────────────────────────────────────────────

export interface FileHit {
  file_name: string;
  folder_path: string;
  mime_type: string;
  snippet: string;
  summary: string;
  category: string;
  score: number;
  modality: string;
}

// ── Organise v2 (search -> judge -> preview -> confirm -> move) ────────

export interface PlannedMove {
  file_name: string;
  from_folder: string;
  to_folder: string;
  reason: string;
}

export interface ProposedGrouping {
  folder_name: string;
  description: string;
}

export interface OrganisePreview {
  plan_id?: string;
  target_folder?: string;
  moves?: PlannedMove[];
  needs_clarification: boolean;
  proposed_groupings?: ProposedGrouping[];
  error?: string;
}

export interface RenamedFile {
  original: string;
  final: string;
}

export interface FailedMove {
  file_name: string;
  error: string;
}

export interface ConfirmOrganiseResult {
  folder_name: string;
  files: string[];
  created: boolean;
  moved: string[];
  renamed?: RenamedFile[];
  failed?: FailedMove[];
  error?: string;
}

// ── Rename (search -> propose names -> preview -> confirm -> rename) ───

export interface PlannedRename {
  file_name: string;
  folder_path: string;
  old_name: string;
  new_name: string;
  reason: string;
  extension_changed?: boolean;
}

export interface RenameSelection {
  file_name: string;
  include: boolean;
  edited_new_name?: string;
}

export interface RenameResultItem {
  original: string;
  final: string;
}

export interface ConfirmRenameResult {
  renamed: RenameResultItem[];
  failed?: FailedMove[];
  error?: string;
}
