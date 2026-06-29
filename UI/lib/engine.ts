// @ts-nocheck
import * as Tone from "tone";

export type StemSource = {id: string; url: string}; 


type Strip = {
    player: Tone.GrainPlayer; 
    gain: Tone.Gain; 
    solo: Tone.Solo; 
    // mute: gain = 0
    last_gain: number; 
    muted: boolean; 
}; 


export class AudioEngine {
    private strips = new Map<string, Strip>();
    private master = new Tone.Gain(0.9).toDestination(); //Tone.master() is too consider as well 
    private rate = 1;
    private detune = 0; 

    async unlock() { await Tone.start();}
    
    async loadStem(sources: StemSource[]) 

    
}




