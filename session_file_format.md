For a saved session, this is the organization of the file

Session_Folder_name: 

    mp3: 
        out_bass.mp3
        out_drums.mp3
        out_other.mp3
        out_vocal.mp3 
    
    user_state:
        {
            "bass": state_bass
            "drum": state_drum
            "other": state_other
            "vocal": state_vocal
        }


state_[    ]: 
    {
        playback_speed -> float (1.3, 0.7....)
        reversed -> Bool
        loop_on -> Bool
        loop_start_end -> (start_time, end_time)
    }


API Flow: 


/temp_stem_folder/
└── <key>/                     ← the sha256 hash from /upload
    ├── original.mp3           ← written by /upload
    └── stems/                 ← written by /separate
        ├── vocals.mp3
        ├── drums.mp3
        ├── bass.mp3
        └── other.mp3