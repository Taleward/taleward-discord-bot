# Erzeugt die vier Töne des Bots (Holzklang, ein Motiv) als WAV und Ogg/Opus und schreibt src/probe/toene.ts.
# Aufruf aus dem Repo-Hauptordner: python3 werkzeuge/toene-erzeugen.py   (braucht numpy und ffmpeg mit libopus)
import base64, subprocess, tempfile, wave
from pathlib import Path
import numpy as np

SR = 48000
D, E, G, H = 293.66, 329.63, 392.0, 493.88
G_TIEF, D_TIEF = 196.0, 146.83


def hall(x, mix=0.18):
    y = x.copy()
    for d, g in ((0.029, 0.5), (0.037, 0.45), (0.043, 0.4), (0.053, 0.35)):
        n = int(SR * d)
        c = np.zeros(len(x))
        for i in range(len(x)):
            c[i] = x[i] + (g * c[i - n] if i >= n else 0)
        y += mix * 0.25 * c
    return y


def holz(f, dauer):
    t = np.arange(int(SR * dauer)) / SR
    env = np.minimum(1, t / 0.003) * np.exp(-t * 7)
    return env * (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t * 20) + 0.08 * np.sin(2 * np.pi * 9.9 * f * t) * np.exp(-t * 30))


def folge(noten, zeiten, laengen, pad=None, gesamt=2.2):
    buf = np.zeros(int(SR * gesamt))
    for f, z, l in zip(noten, zeiten, laengen):
        s = holz(f, l)
        i = int(SR * z)
        buf[i : i + len(s)] += s[: len(buf) - i]
    if pad:
        t = np.arange(len(buf)) / SR
        env = np.minimum(1, t / 0.3) * np.exp(-np.maximum(0, t - 0.4) * 2.0)
        buf += 0.10 * env * np.sin(2 * np.pi * pad * t)
    buf = hall(buf)
    buf *= 0.3 / np.max(np.abs(buf))
    n = int(SR * 0.15)
    buf[-n:] *= np.linspace(1, 0, n)
    return buf


TOENE = {
    "start": folge([D, E, G, H], [0, 0.16, 0.32, 0.56], [1.6, 1.6, 1.8, 2.0], pad=G_TIEF, gesamt=2.2),
    "pause": folge([G, E], [0, 0.2], [1.4, 1.8], gesamt=1.6),
    "weiter": folge([E, G], [0, 0.2], [1.4, 1.8], gesamt=1.6),
    "stopp": folge([H, G, E, D], [0, 0.16, 0.32, 0.56], [1.6, 1.6, 1.8, 2.2], pad=D_TIEF, gesamt=2.4),
}


def wrap(s):
    return "\n".join('  "' + s[i : i + 120] + '" +' for i in range(0, len(s), 120)).rstrip(" +")


teile = []
with tempfile.TemporaryDirectory() as tmp:
    for name, buf in TOENE.items():
        wav = Path(tmp) / f"{name}.wav"
        ogg = Path(tmp) / f"{name}.ogg"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes((np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes())
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(wav), "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", "-application", "audio", "-frame_duration", "20", str(ogg)], check=True)
        b = base64.b64encode(ogg.read_bytes()).decode()
        teile.append(f"export const TON_{name.upper()} = Buffer.from(\n{wrap(b)},\n  \"base64\",\n);\n")

kopf = """// Die vier Töne des Bots als Ogg/Opus (mono, 48 kHz, 32 kbit/s), eingebettet, damit das Repo keine Binärdateien braucht.
// Ein Motiv in Holzklang (Marimba-artig), erzeugt mit werkzeuge/toene-erzeugen.py:
//   Start:  d e g h aufwärts, mit tiefem Grundton   (es läuft; Anfang)
//   Pause:  g e abwärts                             (es ruht; zwischendrin)
//   Weiter: e g aufwärts                            (es läuft; zwischendrin)
//   Stopp:  h g e d abwärts, mit tiefem Grundton    (es ruht; Ende)
// Der erste Anschlag des Starttons ist die Nullmarke der Aufnahme.
// Pause und Weiter werden erst ab Phase 3 gespielt.

"""
Path("src/probe/toene.ts").write_text(kopf + "\n".join(teile), encoding="utf-8")
print("src/probe/toene.ts geschrieben")
