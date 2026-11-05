package vault

import "testing"

func TestSanitizeFileName(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"invalid chars replaced", `Report: Q3 "final"?.pdf`, "Report_ Q3 _final__.pdf"},
		{"backslash and pipe", `a\b|c.txt`, "a_b_c.txt"},
		{"control char", "a\x01b.txt", "a_b.txt"},
		{"trailing dot and space", "name. .", "name"},
		{"reserved name no ext", "CON", "CON_"},
		{"reserved name case-insensitive", "con", "con_"},
		{"reserved name with ext", "CON.txt", "CON_.txt"},
		{"reserved com port", "COM1.pdf", "COM1_.pdf"},
		{"not reserved", "CONTRACT.pdf", "CONTRACT.pdf"},
		{"empty becomes untitled", "", "untitled"},
		{"only invalid chars become underscores", `:::`, "___"},
		{"only dots and spaces becomes untitled", ". . .", "untitled"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := SanitizeFileName(c.input)
			if got != c.want {
				t.Errorf("SanitizeFileName(%q) = %q, want %q", c.input, got, c.want)
			}
		})
	}
}

func TestSanitizeFileNameLengthCap(t *testing.T) {
	long := ""
	for i := 0; i < 200; i++ {
		long += "a"
	}
	got := SanitizeFileName(long + ".txt")
	if len(got) > maxSanitizedNameLen {
		t.Errorf("sanitized name too long: %d chars", len(got))
	}
	if got[len(got)-4:] != ".txt" {
		t.Errorf("truncation ate the extension: %q", got)
	}
}
