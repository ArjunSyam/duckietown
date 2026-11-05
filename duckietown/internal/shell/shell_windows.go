//go:build windows

// Package shell applies Windows-only, HKCU-only, no-admin-required
// Explorer integration for the vault folder: a custom folder icon
// (desktop.ini + attributes) and a OneDrive-style pinned entry in
// Explorer's navigation pane (registry CLSID registration). Every
// exported function here returns an error instead of panicking — the app
// must work with zero shell integration if any of this fails (locked
// file, no registry access, whatever).
package shell

import (
	"crypto/sha256"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed assets/duckietown-folder.ico
var iconBytes []byte

// navPaneCLSID is Duckietown's fixed navigation-pane CLSID — generated
// once (PowerShell `[guid]::NewGuid()`) and hardcoded. NEVER regenerate
// at runtime: a new GUID every launch would orphan the previous one's
// registry tree instead of updating it.
const navPaneCLSID = "{06EFE274-766E-42D6-B205-32B17E9A442B}"

// instanceCLSID is shell32's documented "file system folder as namespace
// extension" instance object CLSID (Microsoft's own sample value for the
// "Integrate a Cloud Storage Provider" pattern) — not ours, never changes.
const instanceCLSID = "{0E5AAE11-A475-4c5b-AB00-C66DE400274E}"

const appDataIconSubdir = `Duckietown\icons`
const iconFileName = "duckietown-folder.ico"
const desktopIniBackupName = ".duckietown-desktop-ini.bak"

// EnsureIcon copies the embedded icon to a stable path under
// %LOCALAPPDATA%\Duckietown\icons\, overwriting only if the on-disk bytes
// differ from the embedded ones. Every other function here takes its
// icon path from this function's return value — never a dev/build temp
// path.
func EnsureIcon() (string, error) {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		return "", fmt.Errorf("shell: LOCALAPPDATA not set")
	}
	dir := filepath.Join(localAppData, appDataIconSubdir)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("shell: mkdir icon dir: %w", err)
	}
	path := filepath.Join(dir, iconFileName)

	if existing, err := os.ReadFile(path); err == nil &&
		sha256.Sum256(existing) == sha256.Sum256(iconBytes) {
		return path, nil // already up to date
	}
	if err := os.WriteFile(path, iconBytes, 0644); err != nil {
		return "", fmt.Errorf("shell: write icon: %w", err)
	}
	return path, nil
}

// RegisterVaultFolder idempotently applies the custom folder icon
// (desktop.ini + attributes) and the nav-pane pin for vaultPath. Safe to
// call on every startup and every vault-path change.
func RegisterVaultFolder(vaultPath string) error {
	iconPath, err := EnsureIcon()
	if err != nil {
		return fmt.Errorf("shell: ensure icon: %w", err)
	}
	if err := applyFolderIcon(vaultPath, iconPath); err != nil {
		return fmt.Errorf("shell: apply folder icon: %w", err)
	}
	if err := registerNavPaneEntry(vaultPath, iconPath); err != nil {
		return fmt.Errorf("shell: register nav pane entry: %w", err)
	}
	notifyShellUpdate(vaultPath)
	return nil
}

// MoveVaultFolder cleans up the folder-icon setup at oldPath (if set and
// different from newPath), then re-applies everything at newPath.
func MoveVaultFolder(oldPath, newPath string) error {
	if oldPath != "" && oldPath != newPath {
		if err := removeFolderIcon(oldPath); err != nil {
			fmt.Printf("⚠️ shell: could not clean up old vault folder icon: %v\n", err)
		}
	}
	return RegisterVaultFolder(newPath)
}

// Remove undoes everything this package applies: the nav-pane registry
// entries, and (if vaultPath != "") desktop.ini + the vault directory's
// read-only attribute.
func Remove(vaultPath string) error {
	var firstErr error
	if err := removeNavPaneEntry(); err != nil {
		firstErr = err
	}
	if vaultPath != "" {
		if err := removeFolderIcon(vaultPath); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	notifyShellUpdate(vaultPath)
	return firstErr
}

// ── desktop.ini + folder attributes ─────────────────────────────────────

// applyFolderIcon writes/updates desktop.ini, preserving any other
// content a different tool may have written. Backs up pre-existing
// content exactly once — the first time it finds a desktop.ini Duckietown
// didn't create — so removeFolderIcon can restore it later instead of
// guessing whether Duckietown created the file from scratch.
func applyFolderIcon(vaultPath, iconPath string) error {
	iniPath := filepath.Join(vaultPath, "desktop.ini")
	backupPath := filepath.Join(vaultPath, desktopIniBackupName)
	iconLine := fmt.Sprintf("IconResource=%s,0", iconPath)

	existing, readErr := os.ReadFile(iniPath)
	var newContent string
	switch {
	case os.IsNotExist(readErr):
		newContent = "[.ShellClassInfo]\r\n" + iconLine + "\r\n"
	case readErr != nil:
		return fmt.Errorf("read desktop.ini: %w", readErr)
	default:
		if _, err := os.Stat(backupPath); os.IsNotExist(err) {
			if err := os.WriteFile(backupPath, existing, 0644); err != nil {
				return fmt.Errorf("backup existing desktop.ini: %w", err)
			}
			_ = windows.SetFileAttributes(toUTF16Ptr(backupPath), windows.FILE_ATTRIBUTE_HIDDEN)
		}
		newContent = upsertIconResourceLine(string(existing), iconLine)
	}

	// Clear attributes first — can't overwrite a hidden+system file on some setups.
	_ = windows.SetFileAttributes(toUTF16Ptr(iniPath), windows.FILE_ATTRIBUTE_NORMAL)
	if err := os.WriteFile(iniPath, []byte(newContent), 0644); err != nil {
		return fmt.Errorf("write desktop.ini: %w", err)
	}
	if err := windows.SetFileAttributes(toUTF16Ptr(iniPath),
		windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM); err != nil {
		return fmt.Errorf("set desktop.ini attributes: %w", err)
	}
	// The documented (and only) signal for Explorer to read a folder's
	// desktop.ini — this does NOT make the folder's contents read-only.
	if err := windows.SetFileAttributes(toUTF16Ptr(vaultPath), windows.FILE_ATTRIBUTE_READONLY); err != nil {
		return fmt.Errorf("set vault dir read-only attribute: %w", err)
	}
	return nil
}

// removeFolderIcon restores desktop.ini from the backup if Duckietown
// modified a pre-existing file, or deletes it outright if Duckietown
// created it from scratch — cleanup only undoes what Duckietown added.
func removeFolderIcon(vaultPath string) error {
	iniPath := filepath.Join(vaultPath, "desktop.ini")
	backupPath := filepath.Join(vaultPath, desktopIniBackupName)

	_ = windows.SetFileAttributes(toUTF16Ptr(iniPath), windows.FILE_ATTRIBUTE_NORMAL)
	if backup, err := os.ReadFile(backupPath); err == nil {
		if err := os.WriteFile(iniPath, backup, 0644); err != nil {
			return fmt.Errorf("restore desktop.ini: %w", err)
		}
		os.Remove(backupPath)
	} else {
		os.Remove(iniPath)
	}

	if attrs, err := getFileAttributes(vaultPath); err == nil {
		_ = windows.SetFileAttributes(toUTF16Ptr(vaultPath), attrs&^windows.FILE_ATTRIBUTE_READONLY)
	}
	return nil
}

// upsertIconResourceLine rewrites (or appends) the IconResource line
// under [.ShellClassInfo], preserving every other line/section verbatim.
// No INI library needed — this only ever touches one key.
func upsertIconResourceLine(content, iconLine string) string {
	lines := strings.Split(content, "\n")
	inSection, sectionFound, replaced := false, false, false
	for i, line := range lines {
		trimmed := strings.TrimSpace(strings.TrimRight(line, "\r"))
		if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
			inSection = strings.EqualFold(trimmed, "[.ShellClassInfo]")
			if inSection {
				sectionFound = true
			}
			continue
		}
		if inSection && strings.HasPrefix(strings.ToLower(trimmed), "iconresource=") {
			lines[i] = iconLine
			replaced = true
		}
	}
	if replaced {
		return strings.Join(lines, "\n")
	}
	if sectionFound {
		for i, line := range lines {
			if strings.EqualFold(strings.TrimSpace(strings.TrimRight(line, "\r")), "[.ShellClassInfo]") {
				out := append(append(append([]string{}, lines[:i+1]...), iconLine), lines[i+1:]...)
				return strings.Join(out, "\n")
			}
		}
	}
	sep := ""
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		sep = "\r\n"
	}
	return content + sep + "[.ShellClassInfo]\r\n" + iconLine + "\r\n"
}

// ── Nav-pane registration (HKCU only) ───────────────────────────────────

// registerNavPaneEntry writes the documented "Integrate a Cloud Storage
// Provider" registry schema for a pinned nav-pane entry pointing at
// vaultPath. Every key/value here is verified against Microsoft's own
// doc for this exact pattern.
func registerNavPaneEntry(vaultPath, iconPath string) error {
	base := `Software\Classes\CLSID\` + navPaneCLSID

	k, _, err := registry.CreateKey(registry.CURRENT_USER, base, registry.ALL_ACCESS)
	if err != nil {
		return fmt.Errorf("create CLSID key: %w", err)
	}
	defer k.Close()
	if err := k.SetStringValue("", "Duckietown"); err != nil {
		return err
	}
	if err := k.SetDWordValue("System.IsPinnedToNameSpaceTree", 1); err != nil {
		return err
	}
	if err := k.SetDWordValue("SortOrderIndex", 0x42); err != nil {
		return err
	}

	iconKey, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\DefaultIcon`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer iconKey.Close()
	if err := iconKey.SetStringValue("", iconPath+",0"); err != nil {
		return err
	}

	inproc, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\InProcServer32`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer inproc.Close()
	if err := inproc.SetExpandStringValue("", `%SystemRoot%\system32\shell32.dll`); err != nil {
		return err
	}

	instance, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\Instance`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer instance.Close()
	if err := instance.SetStringValue("CLSID", instanceCLSID); err != nil {
		return err
	}

	initBag, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\Instance\InitPropertyBag`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer initBag.Close()
	if err := initBag.SetDWordValue("Attributes", 0x11); err != nil {
		return err
	}
	if err := initBag.SetExpandStringValue("TargetFolderPath", vaultPath); err != nil {
		return err
	}

	shellFolder, _, err := registry.CreateKey(registry.CURRENT_USER, base+`\ShellFolder`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer shellFolder.Close()
	if err := shellFolder.SetDWordValue("FolderValueFlags", 0x28); err != nil {
		return err
	}
	if err := shellFolder.SetDWordValue("Attributes", 0xF080004D); err != nil {
		return err
	}

	nsKey, _, err := registry.CreateKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\`+navPaneCLSID, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer nsKey.Close()
	if err := nsKey.SetStringValue("", "Duckietown"); err != nil {
		return err
	}

	hideKey, _, err := registry.CreateKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel`, registry.ALL_ACCESS)
	if err != nil {
		return err
	}
	defer hideKey.Close()
	return hideKey.SetDWordValue(navPaneCLSID, 1)
}

// removeNavPaneEntry deletes everything registerNavPaneEntry wrote.
// Deletes only the {navPaneCLSID} VALUE under HideDesktopIcons\
// NewStartPanel, never the key itself — it holds other apps' (e.g.
// OneDrive's) unrelated entries too.
func removeNavPaneEntry() error {
	var firstErr error
	if err := deleteKeyRecursive(registry.CURRENT_USER, `Software\Classes\CLSID\`+navPaneCLSID); err != nil {
		firstErr = err
	}
	if err := registry.DeleteKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\`+navPaneCLSID); err != nil && firstErr == nil {
		firstErr = err
	}
	if k, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel`, registry.SET_VALUE); err == nil {
		defer k.Close()
		if err := k.DeleteValue(navPaneCLSID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// deleteKeyRecursive deletes path and every subkey beneath it — the
// stdlib registry package only deletes a key with zero subkeys.
func deleteKeyRecursive(root registry.Key, path string) error {
	k, err := registry.OpenKey(root, path, registry.ALL_ACCESS)
	if err != nil {
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	names, err := k.ReadSubKeyNames(-1)
	k.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := deleteKeyRecursive(root, path+`\`+name); err != nil {
			return err
		}
	}
	return registry.DeleteKey(root, path)
}

// ── Shell notifications + small helpers ─────────────────────────────────

var (
	shell32            = windows.NewLazySystemDLL("shell32.dll")
	procSHChangeNotify = shell32.NewProc("SHChangeNotify")
)

const (
	shcneUpdateItem   = 0x00002000
	shcneAssocChanged = 0x08000000
	shcnfPathW        = 0x0005
	shcnfIDList       = 0x0000
)

// notifyShellUpdate tells Explorer to refresh without a restart. Known
// caveat: nav-pane root re-enumeration sometimes still needs an Explorer
// restart/sign-out on some Windows builds despite this call.
func notifyShellUpdate(vaultPath string) {
	if vaultPath != "" {
		if p, err := windows.UTF16PtrFromString(vaultPath); err == nil {
			procSHChangeNotify.Call(uintptr(shcneUpdateItem), uintptr(shcnfPathW), uintptr(unsafe.Pointer(p)), 0)
		}
	}
	procSHChangeNotify.Call(uintptr(shcneAssocChanged), uintptr(shcnfIDList), 0, 0)
}

func toUTF16Ptr(s string) *uint16 {
	p, _ := windows.UTF16PtrFromString(s)
	return p
}

func getFileAttributes(path string) (uint32, error) {
	return windows.GetFileAttributes(toUTF16Ptr(path))
}
