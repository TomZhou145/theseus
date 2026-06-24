// import * as Tone from "tone";


// const BASE = process.env.NEXT_PUBLIC_API_URL!;

// type stem = {
//     name: string; 
//     buffer: AudioBuffer; // decoded PCM — feeds playback, waveform, duration
//     blob: Blob;          // original mp3 bytes — feeds the download button
//     };



// // Song data transfer converstion, base64 -> bytes for JSON
// function base64ToBytes(b64: string): Uint8Array {

//   const bin = atob(b64);                    
//   const bytes = new Uint8Array(bin.length);
//   for (let i = 0; i < bin.length; i++) 
//     {
//     bytes[i] = bin.charCodeAt(i);          
//     }

//   return bytes;
// }

// // gpu_image = (
// //     modal.Image.debian_slim(python_version="3.11")
// //     .apt_install("ffmpeg")
// //     .pip_install("demucs", "torch", "torchaudio", "soundfile")
// // )





// // web_image = modal.Image.debian_slim().pip_install("fastapi[standard]")
