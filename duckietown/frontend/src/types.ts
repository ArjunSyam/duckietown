export interface FileRecord {
  name: string;
  size: number;
  mime_type: string;
  created_at: string;
  updated_at: string;
  storage_path: string;
  is_dir: boolean;
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
}
