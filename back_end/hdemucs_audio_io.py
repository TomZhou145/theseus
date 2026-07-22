import modal


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")                               
    .pip_install("git+https://github.com/adefossez/demucs","torch", "torchaudio", "numpy<2")    
)

app = modal.App("stem-tool")
web_image = modal.Image.debian_slim().pip_install("fastapi[standard]")

cache = modal.Volume.from_name("temp_stem_folder", create_if_missing=True)
CACHE_DIR = "/temp_stem_folder"

# ----------------------------------- Stem Separation API calls ----------------------------/n 

def choose_model(model_name='htdemucs'):
    from demucs.api import Separator
    if model_name == 'htdemucs':
        # Load the htdemucs model
        return Separator(model="htdemucs")      
    
    raise ValueError(f"Model '{model_name}' is currently not supported.")


@app.cls(gpu="T4", image=image)
class Model_Engine:
    @modal.enter()
    def __enter__(self):
        import torch
        print("CUDA available:", torch.cuda.is_available())  
        print("Loading HTDemucus...")
        self.model = choose_model(model_name='htdemucs')
        print("Model loaded.")
    
    @modal.method()
    def separate(self, audio_bytes: bytes) -> dict:        
        import tempfile, os
        from demucs.api import save_audio
        import numpy as np

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)                 
            path = f.name

        _, stems = self.model.separate_audio_file(path)
        out = {}

        for name, source in stems.items():
            p = f"/tmp/{name}.mp3"
            save_audio(source, p, samplerate=self.model.samplerate, bitrate=320)
            out[name] = open(p, "rb").read()

        os.remove(path)
        return out
        

# ----------------------------------- Program Flow initialized ----------------------------/n 


@app.function(image=web_image, timeout=3600, volumes={CACHE_DIR:cache})
@modal.asgi_app()
def web():

    # ------- dependencies ------- 
    import base64, hashlib, pathlib
    from fastapi import FastAPI, UploadFile, File, Body
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware

    api = FastAPI()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://localhost:3001", "https://theseus-lemon.vercel.app"],
        allow_methods=["*"], allow_headers=["*"],
    )

# input type / size sanitaztion
    ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aiff", ".aif", ".webm"}
    ALLOWED_MIME_TYPES = {
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
        "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/ogg", "audio/flac",
        "audio/aiff", "audio/x-aiff", "audio/webm",
    }
    MAX_UPLOAD_BYTES = 100 * 1024 * 1024 

    @api.post("/upload")
    async def upload(file: UploadFile = File(...)):
        ext = pathlib.Path(file.filename or "").suffix.lower()
        mime = (file.content_type or "").split(";")[0].strip()
        if ext not in ALLOWED_EXTENSIONS and mime not in ALLOWED_MIME_TYPES:
            return JSONResponse(
                {"error": f"Unsupported file type '{ext or mime}'. Accepted: {', '.join(sorted(ALLOWED_EXTENSIONS))}"},
                status_code=415,
            )

        data = await file.read()

        if len(data) > MAX_UPLOAD_BYTES:
            return JSONResponse(
                {"error": f"File too large ({len(data) // (1024*1024)} MB). Maximum is {MAX_UPLOAD_BYTES // (1024*1024)} MB."},
                status_code=413,
            )

        # new file + reset cache for new upload session
        cache.reload()

        digest = hashlib.sha256(data).hexdigest()[:16] #encrypy for hash/cache
        ext = pathlib.Path(file.filename or "audio").suffix or ".bin"
        base = pathlib.Path(CACHE_DIR) / digest 
        original = base / f"original{ext}"

        if original.exists():
            return {"key": digest,
                    "filename": file.filename,
                    "cached": True,
                    "Bytes": len(data)}
        
        base.mkdir(parents=True,exist_ok=True)
        original.write_bytes(data)
        cache.commit()

        return {"key": digest,
                "filename": file.filename,
                "cached": False,
                "bytes": len(data)}

    #entry point to add more models later....
    @api.post("/separate")
    async def separate(key: str = Body(..., embed=True)):

        cache.reload()
        base = pathlib.Path(CACHE_DIR) / key 
        if not base.exists():
            return JSONResponse({"error": "No Uploaded Song Found"}, status_code=404)

        stems_dir = base / "stems"

        # cache hit, song found in cache
        if stems_dir.exists() and any(stems_dir.iterdir()):
            files = sorted(stems_dir.glob("*.mp3"))
            return {
            "format": "mp3", "cached": True,
            "stems": {f.stem: base64.b64encode(f.read_bytes()).decode("ascii") for f in files},
            }
        
        # cache miss, make new folder, name oroginal as original.mp3
        original = next(base.glob("original.*"), None)
        if original is None:
            return JSONResponse({"error": "Original Upload not found in cache"}, status_code = 404)

        #pull data
        audio_bytes = original.read_bytes()
        #separate
        stems = Model_Engine().separate.remote(audio_bytes)   # {name: mp3 bytes}
        
        stems_dir.mkdir(parents=True, exist_ok=True)
        for name,b in stems.items():
            (stems_dir / f"{name}.mp3").write_bytes(b)
        cache.commit()

        #send back, boom
        return {
            # return with mp3 for quick process, wav for quality high: 
            "format": "mp3",
            "stems": {
                name: base64.b64encode(data).decode("ascii")
                for name, data in stems.items()
            },
        }
    return api

    

# Cost about $0.01 per run on T4, for a song with 2:56 minutes, 4 stems
# 50 seconds to separate a song that is 4:24 
# song_2 = "HauntedShoreVibe_demo1.wav"
# song_3 = "dying_star.m4a"
# song_to_process = "obsession.mp3"

# @app.local_entrypoint()
# def main(audio_path: str = song_to_process):
#     audio_bytes = open(audio_path, "rb").read()  
#     engine = Model_Engine()
#     stems = engine.separate.remote(audio_bytes)
#     for name, data in stems.items():
#         open(f"{audio_path}_out_{name}.mp3", "wb").write(data)
#         print(f"saved {audio_path}_out_{name}.mp3")

                                            