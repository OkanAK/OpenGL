// Medicare Fridays desktop app for Windows.
//
// Serves the page on 127.0.0.1 and shows it in its own window using the
// Microsoft Edge WebView2 runtime. If WebView2 is missing, it opens the page in
// the default browser instead and quits once that tab has been closed.
// Patients are saved to %APPDATA%\MedicareFridays\patients.json.
package main

import (
	_ "embed"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	webview2 "github.com/jchv/go-webview2"
)

//go:embed app.html
var page []byte

var (
	mu       sync.Mutex
	lastPing = time.Now()
)

func dataDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir, _ = os.Getwd()
	}
	dir = filepath.Join(dir, "MedicareFridays")
	os.MkdirAll(dir, 0o755)
	return dir
}

func main() {
	store := filepath.Join(dataDir(), "patients.json")

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(page)
	})
	mux.HandleFunc("/api/patients", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPost {
			body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
			var check []map[string]any
			if err != nil || json.Unmarshal(body, &check) != nil {
				http.Error(w, "bad patient list", http.StatusBadRequest)
				return
			}
			tmp := store + ".tmp"
			if os.WriteFile(tmp, body, 0o644) != nil || os.Rename(tmp, store) != nil {
				http.Error(w, "could not save", http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		patients := json.RawMessage("[]")
		if b, err := os.ReadFile(store); err == nil && json.Valid(b) {
			patients = b
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"app": "medicare-fridays", "patients": patients})
	})
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastPing = time.Now()
		mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(1)
	}
	go http.Serve(ln, mux)
	url := "http://" + ln.Addr().String() + "/"

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(dataDir(), "webview"),
		WindowOptions: webview2.WindowOptions{
			Title:  "Medicare Fridays",
			Width:  620,
			Height: 860,
			IconId: 1,
			Center: true,
		},
	})
	if w != nil {
		defer w.Destroy()
		w.Navigate(url)
		w.Run()
		return
	}

	// No WebView2: use the default browser and quit when the page stops checking in.
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	for {
		time.Sleep(10 * time.Second)
		mu.Lock()
		idle := time.Since(lastPing)
		mu.Unlock()
		if idle > 45*time.Second {
			return
		}
	}
}
