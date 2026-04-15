import { useState } from "react";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  Trash2,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FolderRecord } from "../types";

interface Props {
  folders: FolderRecord[];
  currentFolder: string; // currently open folder path
  onSelectFolder: (path: string) => void;
  onCreateFolder: (parentPath: string, name: string) => void;
  onDeleteFolder: (path: string) => void;
  onDropFile: (fileName: string, targetFolderPath: string) => void;
}

interface TreeNode {
  record: FolderRecord;
  children: TreeNode[];
}

function buildTree(folders: FolderRecord[], parentPath: string): TreeNode[] {
  return folders
    .filter((f) => f.parent === parentPath)
    .map((f) => ({
      record: f,
      children: buildTree(folders, f.path),
    }));
}

export function FolderTree({
  folders,
  currentFolder,
  onSelectFolder,
  onCreateFolder,
  onDeleteFolder,
  onDropFile,
}: Props) {
  const tree = buildTree(folders, "");

  return (
    <div className="flex flex-col gap-0.5">
      {/* Root */}
      <FolderNode
        path=""
        name="All Files"
        depth={0}
        isRoot
        isOpen={currentFolder === ""}
        children={tree}
        currentFolder={currentFolder}
        onSelectFolder={onSelectFolder}
        onCreateFolder={onCreateFolder}
        onDeleteFolder={onDeleteFolder}
        onDropFile={onDropFile}
      />
    </div>
  );
}

interface NodeProps {
  path: string;
  name: string;
  depth: number;
  isRoot?: boolean;
  isOpen: boolean;
  children: TreeNode[];
  currentFolder: string;
  onSelectFolder: (path: string) => void;
  onCreateFolder: (parentPath: string, name: string) => void;
  onDeleteFolder: (path: string) => void;
  onDropFile: (fileName: string, targetFolderPath: string) => void;
}

function FolderNode({
  path,
  name,
  depth,
  isRoot,
  isOpen,
  children,
  currentFolder,
  onSelectFolder,
  onCreateFolder,
  onDeleteFolder,
  onDropFile,
}: NodeProps) {
  const [expanded, setExpanded] = useState(isRoot || isOpen);
  const [creatingChild, setCreatingChild] = useState(false);
  const [newName, setNewName] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const isSelected = currentFolder === path;
  const hasChildren = children.length > 0;

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = () => setDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const fileName = e.dataTransfer.getData("text/plain");
    if (fileName) onDropFile(fileName, path);
  };

  const commitCreate = () => {
    const trimmed = newName.trim();
    if (trimmed) {
      const fullPath = path ? `${path}/${trimmed}` : trimmed;
      onCreateFolder(path, trimmed);
      onSelectFolder(fullPath);
    }
    setCreatingChild(false);
    setNewName("");
  };

  return (
    <div>
      {/* Row */}
      <div
        className={`flex items-center gap-1 px-2 py-[6px] rounded-sm cursor-pointer transition-colors group
          ${isSelected ? "nav-active font-medium" : "text-[#9d9d9d] hover:text-[#d4d4d4] hover:bg-[#2d2d30]"}
          ${dragOver ? "bg-indigo-500/20 border border-indigo-500/40" : ""}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => {
          onSelectFolder(path);
          if (hasChildren) setExpanded((v) => !v);
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Chevron */}
        <span className="w-3 shrink-0 text-[#4a4a4a]">
          {hasChildren ? (
            expanded ? (
              <ChevronDown size={10} />
            ) : (
              <ChevronRight size={10} />
            )
          ) : null}
        </span>

        {/* Icon */}
        {isSelected || expanded ? (
          <FolderOpen size={13} className="shrink-0" />
        ) : (
          <Folder size={13} className="shrink-0" />
        )}

        <span className="flex-1 text-xs truncate">{name}</span>

        {/* Actions — visible on hover */}
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="w-4 h-4 text-[#4a4a4a] hover:text-[#d4d4d4]"
            onClick={(e) => {
              e.stopPropagation();
              setCreatingChild(true);
              setExpanded(true);
            }}
          >
            <FolderPlus size={10} />
          </Button>
          {!isRoot && (
            <Button
              variant="ghost"
              size="icon"
              className="w-4 h-4 text-[#4a4a4a] hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteFolder(path);
              }}
            >
              <Trash2 size={10} />
            </Button>
          )}
        </span>
      </div>

      {/* Inline create input */}
      {creatingChild && (
        <div
          style={{ paddingLeft: `${8 + (depth + 1) * 12}px` }}
          className="pr-2 py-1"
        >
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCreate();
              if (e.key === "Escape") {
                setCreatingChild(false);
                setNewName("");
              }
            }}
            onBlur={commitCreate}
            placeholder="folder name…"
            className="h-6 text-[11px] px-1.5 bg-[#1e1e1e] border-indigo-500"
          />
        </div>
      )}

      {/* Children */}
      {expanded &&
        children.map((node) => (
          <FolderNode
            key={node.record.path}
            path={node.record.path}
            name={node.record.name}
            depth={depth + 1}
            isOpen={
              currentFolder === node.record.path ||
              currentFolder.startsWith(node.record.path + "/")
            }
            isRoot={false}
            children={node.children}
            currentFolder={currentFolder}
            onSelectFolder={onSelectFolder}
            onCreateFolder={onCreateFolder}
            onDeleteFolder={onDeleteFolder}
            onDropFile={onDropFile}
          />
        ))}
    </div>
  );
}
