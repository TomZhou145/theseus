// @ts-nocheck
import * as Tone from "tone";
import audioBufferToWav from "audiobuffer-to-wav"


export type StemSource = {id: string; url: string}; 


type Strip = {
    player: Tone.GrainPlayer; 
    gain: Tone.Gain; 
    solo: Tone.Solo; 
    // mute: gain = 0
    last_gain: number; 
    muted: boolean; 
    pan: number;
}; 


export class AudioEngine {

    private strips = new Map<string, Strip>();
    private master = new Tone.Gain(0.9).toDestination(); 
    private rate = 1;
    private detune = 0; 

    // Tone.start(), call on first user gesture
    async unlock() { 
        await Tone.start();
    }
    
    async loadStem(sources: StemSource[]) {
        //  Existing strip clean up
        for (const strip of this.strips.values()) {
            strip.player.dispose();
            strip.gain.dispose();
            strip.solo.dispose();
        }
        this.strips.clear();

        for (const source of sources) {
            const player = new Tone.GrainPlayer(source.url);
            const gain = new Tone.Gain(0.8); 
            const solo = new Tone.Solo(); 
            // const pan = new Tone.Panner(0);
            player.sync().start(0);  

            //  signal flow: 
            // player -> gain -> solo -> pan -> master
            player.connect(gain);
            gain.connect(solo);
            // pan.connect(this.solo); 
            solo.connect(this.master);

            this.strips.set(source.id, 
                            { player, 
                            gain, 
                            solo, 
                            last_gain: 0.8, 
                            muted: false,
                            pan: 0}
                            ); 
        }

        await Tone.loaded(); 
    } 

   // build a Strip per stem, wire the chain, sync to Transport



    async play(): Promise<void>
    {
        await Tone.start();
        Tone.Transport.start(); 
    }

    pause(): void
    {
        Tone.Transport.pause(); 
    }

    async seek(seconds: number): Promise<void>              
    {
        await Tone.start();
        Tone.Transport.seconds = seconds;
        // Transport.seconds = ...
    }

    setLoop(start: number, end: number, enabled: boolean): void
    {
        Tone.Transport.loop = enabled;
        Tone.Transport.loopStart = start;
        Tone.Transport.loopEnd = end;
    }

    setRate(rate: number): void     
    {
        this.rate = Math.max(0.1, Math.min(4, rate));
        for (const strip of this.strips.values()) {
            strip.player.playbackRate = this.rate;
        }
    }            

    setDetune(cents: number): void        
    {
        this.detune = Math.max(-2400, Math.min(2400, cents)); 
        // [-2400,2400] 2 octaves  
        for (const strip of this.strips.values()) {
            strip.player.detune = this.detune;
        }
    }    
            // (transpose*100 + cents + a432 offset) applied to every strip's .detune
    setMasterVolume(v: number): void {
        const gain = this.master.gain; 
        gain.value = v;
    }


    setStemVolume(id: string, v: number): void {
        const strip = this.strips.get(id);
        if (! strip) return; 
        strip.gain.gain.value = v; 
    }


    setMute(id: string, muted: boolean): void {
        const strip = this.strips.get(id);
        if (! strip) return;
        if (! muted) {
            strip.gain.gain.value = strip.last_gain
        }
        else {
            strip.last_gain = strip.gain.gain.value;
            strip.gain.gain.value = 0;
        }
    }      

    setSolo(id: string, soloed: boolean): void {
        const strip = this.strips.get(id);
        if (! strip) return;
        strip.solo.solo = soloed;
    }        

    // playhead tracker 
    onTimeUpdate(cb: (t: number) => void): () => void  {
        let frameId: number 
        const tick = () => {

            cb(Tone.Transport.seconds);
            frameId = requestAnimationFrame(tick);
        }; 
        frameId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frameId);

    }
    
   
    async exportMix(): Promise<Blob> {

        // using longest strip duration matched to play rate for length 
        const duration = Math.max(
            ...Array.from(this.strips.values()).map(s => s.player.buffer.duration / this.rate)
        );


        //merging master output to wav 
        const rendered = await Tone.Offline(() => {
            const offline_Master = new Tone.Gain(this.master.gain.value).toDestination();

            for (const strip of this.strips.values()) {
                const player = new Tone.GrainPlayer(strip.player.buffer);
                const gain = new Tone.Gain(strip.gain.gain.value); 
                const solo = new Tone.Solo(); 
                solo.solo = strip.solo.solo; 

                player.playbackRate = this.rate;
                player.detune = this.detune; 

                player.connect(gain);
                gain.connect(solo);
                solo.connect(offline_Master);  

                player.start(0);
            } 
            
        }, duration); 

        const wavArrayBuffer = await audioBufferToWav(rendered.get());
        return new Blob([wavArrayBuffer], { type: "audio/wav" });
    }                 // later: Tone.Offline() renders the whole graph to a buffer → encode → download


}