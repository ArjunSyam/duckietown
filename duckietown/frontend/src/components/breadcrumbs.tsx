import { ChevronRight, Home } from "lucide-react";

interface Props {
  currentFolder: string; // e.g. "work/invoices/2024"
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ currentFolder, onNavigate }: Props) {
  const segments = currentFolder ? currentFolder.split("/") : [];

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-[#3e3e42] bg-[#1e1e1e] text-xs shrink-0">
      <button
        onClick={() => onNavigate("")}
        className="flex items-center gap-1 text-[#6a6a6a] hover:text-[#d4d4d4] transition-colors"
      >
        <Home size={11} />
        <span>Vault</span>
      </button>

      {segments.map((seg, i) => {
        const path = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        return (
          <span key={path} className="flex items-center gap-1">
            <ChevronRight size={10} className="text-[#3e3e42]" />
            <button
              onClick={() => onNavigate(path)}
              className={`transition-colors ${
                isLast
                  ? "text-[#d4d4d4] font-medium cursor-default"
                  : "text-[#6a6a6a] hover:text-[#d4d4d4]"
              }`}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}
