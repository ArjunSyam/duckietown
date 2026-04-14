package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

var sidecarCmd *exec.Cmd

func (a *App) startSidecar() error {
	// Kill any leftover sidecar from a previous dev session on this port
	killProcessOnPort(8000)
	time.Sleep(300 * time.Millisecond)

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot determine executable path: %w", err)
	}
	exeDir := filepath.Dir(exePath)

	sidecarBin := filepath.Join(exeDir, "sidecar", "duckietown_sidecar", "duckietown_sidecar")
	if runtime.GOOS == "windows" {
		sidecarBin += ".exe"
	}

	var cmd *exec.Cmd
	if _, statErr := os.Stat(sidecarBin); statErr == nil {
		cmd = exec.Command(sidecarBin)
		fmt.Println("🐍 Starting bundled sidecar:", sidecarBin)
	} else {
		sidecarScript, findErr := findSidecarScript(exeDir)
		if findErr != nil {
			return fmt.Errorf("cannot find sidecar/main.py: %w", findErr)
		}

		pythonBin := "python3"
		if runtime.GOOS == "windows" {
			pythonBin = "python"
		}

		venvPython := filepath.Join(filepath.Dir(sidecarScript), ".venv", "bin", "python3")
		if runtime.GOOS == "windows" {
			venvPython = filepath.Join(filepath.Dir(sidecarScript), ".venv", "Scripts", "python.exe")
		}
		if _, verr := os.Stat(venvPython); verr == nil {
			pythonBin = venvPython
		}

		cmd = exec.Command(pythonBin, sidecarScript)
		fmt.Println("🐍 Starting dev sidecar:", sidecarScript)
		fmt.Println("🐍 Python:", pythonBin)
	}

	chromaDir := filepath.Join(userDataDir(), "chromadb")
	os.MkdirAll(chromaDir, 0700)

	cmd.Env = append(os.Environ(),
		"SIDECAR_PORT=8000",
		"CHROMA_DIR="+chromaDir,
		"OPENROUTER_API_KEY="+os.Getenv("OPENROUTER_API_KEY"),
		"OPENROUTER_MODEL="+getEnvOrDefault("OPENROUTER_MODEL", "google/gemma-3-27b-it"),
		// Silence ChromaDB telemetry — fixes "capture() takes 1 positional argument" noise
		"ANONYMIZED_TELEMETRY=False",
		"CHROMA_TELEMETRY=False",
	)

	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start sidecar process: %w", err)
	}
	sidecarCmd = cmd
	fmt.Printf("🐍 Sidecar PID: %d\n", cmd.Process.Pid)

	if err := waitForSidecar("http://127.0.0.1:8000/health", 60); err != nil {
		cmd.Process.Kill()
		return fmt.Errorf("sidecar did not become healthy: %w", err)
	}
	fmt.Println("✅ Sidecar ready")
	return nil
}

// killProcessOnPort kills whatever process is holding the given port.
func killProcessOnPort(port int) {
	if runtime.GOOS == "windows" {
		exec.Command("cmd", "/C",
			fmt.Sprintf("for /f \"tokens=5\" %%a in ('netstat -aon ^| findstr :%d') do taskkill /F /PID %%a", port),
		).Run()
	} else {
		out, err := exec.Command("lsof", "-ti", fmt.Sprintf(":%d", port)).Output()
		if err != nil || len(out) == 0 {
			return
		}
		exec.Command("sh", "-c",
			fmt.Sprintf("lsof -ti :%d | xargs kill -9", port),
		).Run()
		fmt.Printf("🔫 Killed stale process on port %d\n", port)
	}
}

func findSidecarScript(start string) (string, error) {
	dir := start
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "sidecar", "main.py")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("not found in any ancestor of %s", start)
}

func waitForSidecar(url string, timeoutSecs int) error {
	deadline := time.Now().Add(time.Duration(timeoutSecs) * time.Second)
	attempt := 0
	for time.Now().Before(deadline) {
		attempt++
		resp, err := http.Get(url)
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			fmt.Printf("✅ Sidecar healthy after %d attempts\n", attempt)
			return nil
		}
		if attempt%10 == 0 {
			fmt.Printf("⏳ Waiting for sidecar... (%ds elapsed)\n", attempt/2)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("timeout after %ds — check sidecar output above for errors", timeoutSecs)
}

func stopSidecar() {
	if sidecarCmd != nil && sidecarCmd.Process != nil {
		fmt.Println("🛑 Stopping sidecar...")
		sidecarCmd.Process.Kill()
		sidecarCmd.Wait()
	}
}

func userDataDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".duckietown")
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
