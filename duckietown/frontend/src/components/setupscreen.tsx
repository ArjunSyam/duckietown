import { FolderOpen, FileStack, Cloud, Github, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface Props {
  onSetup: () => void;
}

const ACTIONS = [
  {
    icon: <FolderOpen size={15} />,
    label: "Open Vault Folder",
    shortcut: "Ctrl+O",
    primary: true,
    action: "setup",
  },
  {
    icon: <FileStack size={15} />,
    label: "Browse Recent",
    shortcut: "Ctrl+R",
    primary: false,
    action: null,
  },
  {
    icon: <BookOpen size={15} />,
    label: "Read Documentation",
    shortcut: "",
    primary: false,
    action: null,
  },
  {
    icon: <Github size={15} />,
    label: "View on GitHub",
    shortcut: "",
    primary: false,
    action: null,
  },
];

export function SetupScreen({ onSetup }: Props) {
  return (
    <div className="h-screen flex items-center justify-center bg-[#1c1c1c]">
      {/* Subtle grid background */}
      <div
        className="absolute inset-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgb(212 212 212) 1px, transparent 1px), linear-gradient(90deg, rgb(212 212 212) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="relative z-10 w-[520px] fade-in">
        {/* Logo + title */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
            <Cloud size={26} className="text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[#d4d4d4] tracking-tight">
              Duckietown
            </h1>
            <p className="text-sm text-[#6a6a6a] mt-0.5">
              Your smart cloud file system
            </p>
          </div>
        </div>

        {/* Main card */}
        <div className="bg-[#252526] border border-[#3e3e42] rounded-xl overflow-hidden shadow-2xl">
          {/* GET STARTED section */}
          <div className="px-5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#5a5a5a] mb-2">
              Get Started
            </p>
            <div className="flex flex-col gap-0.5">
              {ACTIONS.map((item) => (
                <button
                  key={item.label}
                  onClick={item.action === "setup" ? onSetup : undefined}
                  className={`group flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors text-left
                    ${
                      item.primary
                        ? "hover:bg-indigo-500/10 text-[#d4d4d4]"
                        : "hover:bg-[#2d2d30] text-[#9d9d9d] hover:text-[#d4d4d4]"
                    }`}
                >
                  <span
                    className={`shrink-0 ${item.primary ? "text-indigo-400" : "text-[#6a6a6a] group-hover:text-[#9d9d9d]"}`}
                  >
                    {item.icon}
                  </span>
                  <span className="flex-1 text-sm font-medium">
                    {item.label}
                  </span>
                  {item.shortcut && (
                    <kbd className="text-[10px] font-mono text-[#4a4a4a] bg-[#1e1e1e] border border-[#3e3e42] px-1.5 py-0.5 rounded">
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              ))}
            </div>
          </div>

          <Separator className="bg-[#3e3e42]" />

          {/* Recent projects section */}
          <div className="px-5 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[1.5px] text-[#5a5a5a] mb-2">
              Recent Vaults
            </p>
            <div className="flex flex-col gap-0.5">
              <div className="px-3 py-2.5 text-sm text-[#4a4a4a] italic">
                No recent vaults
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="mt-5 flex items-center gap-3">
          <Button
            onClick={onSetup}
            className="bg-indigo-600 hover:bg-indigo-500 text-white gap-2 font-medium"
          >
            <FolderOpen size={15} />
            Choose Vault Folder
          </Button>
          <p className="text-xs text-[#4a4a4a]">
            Files saved here sync to Supabase automatically
          </p>
        </div>

        {/* Version */}
        <p className="mt-6 text-[11px] text-[#3a3a3a] font-mono">
          Duckietown v0.1.0 · Built with Wails + React
        </p>
      </div>
    </div>
  );
}
