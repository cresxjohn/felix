"""Felix's voice: Kokoro text to speech, kept running so a sentence doesn't wait for the model to load.

Started by felix-voice.mjs with the model and voices files. It reads one JSON request per line on stdin and
answers each with one JSON line on stdout, carrying the request's id:

  {"id": 1, "text": "Hi there.", "voice": "am_michael", "speed": 1.0, "out": "/tmp/a.wav"}
      -> {"id": 1, "ok": true, "seconds": 0.9}
  {"id": 2, "voices": true}
      -> {"id": 2, "voices": ["am_michael", ...]}
  {"id": 3, "phonemize": "Hi there.", "voice": "am_michael"}
      -> {"id": 3, "phonemes": "hˈaɪ ðˈɛɹ."}   (the sounds, for a device that makes the voice itself)
  {"id": 4, "warm": true}
      -> {"id": 4, "ok": true}   (loads the model ahead of the first sentence)

The model loads on the first request that needs it, so working out sounds starts at once.

A failed request answers {"id": ..., "error": "..."} and the worker carries on.
"""
import json
import os
import subprocess
import sys
import wave

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro
from kokoro_onnx.tokenizer import Tokenizer


def write_wav(path, samples, rate):
    """Saves float samples as a 16-bit mono WAV file."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())


def accent(voice):
    """The English a voice speaks: Kokoro's British voices start with "b", the American ones with "a"."""
    return "en-gb" if voice.startswith("b") else "en-us"


def answer(kokoro, request):
    """Carries out one request that needs the model: get it ready, list the voices, or speak a text into a file."""
    if request.get("warm"):
        return {"ok": True}
    if request.get("voices"):
        return {"voices": sorted(kokoro.get_voices())}
    voice = request.get("voice", "am_michael")
    samples, rate = kokoro.create(
        request["text"],
        voice=voice,
        speed=float(request.get("speed", 1.0)),
        lang=accent(voice),
    )
    write_wav(request["out"], samples, rate)
    return {"ok": True, "seconds": round(len(samples) / rate, 2)}


def fast_cores():
    """How many of the Mac's performance cores there are: Kokoro runs best on just those, rather than spread over
    the efficiency cores too while the rest of the Mac is busy."""
    try:
        out = subprocess.run(["sysctl", "-n", "hw.perflevel0.physicalcpu"], capture_output=True, text=True, timeout=2)
        return max(1, int(out.stdout.strip()))
    except (OSError, ValueError, subprocess.SubprocessError):
        return max(1, (os.cpu_count() or 4) // 2)


def load_model():
    """Loads Kokoro, on the fast cores, and makes one throwaway sentence, since the first one is always slow."""
    options = ort.SessionOptions()
    options.intra_op_num_threads = fast_cores()
    session = ort.InferenceSession(sys.argv[1], options, providers=["CPUExecutionProvider"])
    kokoro = Kokoro.from_session(session, sys.argv[2])
    kokoro.create("Hi.", voice="am_michael", speed=1.0, lang="en-us")
    return kokoro


def main():
    """Gets the sounds side (espeak) ready, says it's ready, and answers requests until stdin closes. The model loads
    on the first request that needs it, so working out sounds for another device never waits on it."""
    tokenizer = Tokenizer()
    tokenizer.phonemize("Hi.", "en-us")
    print(json.dumps({"ready": True}), flush=True)
    kokoro = None
    for line in sys.stdin:
        if not line.strip():
            continue
        request = {}
        try:
            request = json.loads(line)
            if request.get("phonemize") is not None:
                phonemes = tokenizer.phonemize(str(request["phonemize"]), accent(request.get("voice", "am_michael")))
                reply = {"phonemes": phonemes}
            else:
                kokoro = kokoro or load_model()
                reply = answer(kokoro, request)
        except Exception as error:
            reply = {"error": str(error) or type(error).__name__}
        reply["id"] = request.get("id")
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
