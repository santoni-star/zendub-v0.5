#!/usr/bin/env python3
"""
Time-stretch audio file to match target duration without changing pitch.
Usage: python time_stretch.py <input_file> <target_duration_sec> <output_file>
"""

import sys
import librosa
import soundfile as sf
import numpy as np

def time_stretch_audio(input_file, target_duration, output_file):
    """
    Time-stretch audio to target duration preserving pitch.
    
    Args:
        input_file: Path to input MP3/WAV file
        target_duration: Target duration in seconds (float)
        output_file: Path to output MP3/WAV file
    """
    try:
        # Load audio
        y, sr = librosa.load(input_file, sr=None)
        
        # Calculate current duration
        current_duration = len(y) / sr
        
        # Calculate stretch rate
        rate = current_duration / target_duration
        
        # Avoid extreme stretching
        if rate < 0.5:
            print(f"WARNING: Extreme slow-down ({rate:.2f}x), clamping to 0.5x", file=sys.stderr)
            rate = 0.5
        elif rate > 2.5:
            print(f"WARNING: Extreme speed-up ({rate:.2f}x), clamping to 2.5x", file=sys.stderr)
            rate = 2.5
        
        # Apply time-stretch
        y_stretched = librosa.effects.time_stretch(y, rate=rate)
        
        # Save output
        sf.write(output_file, y_stretched, sr)
        
        # Print stats
        new_duration = len(y_stretched) / sr
        print(f"SUCCESS: {current_duration:.2f}s -> {new_duration:.2f}s (rate={rate:.3f}x)", file=sys.stderr)
        
        return 0
        
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python time_stretch.py <input_file> <target_duration> <output_file>", file=sys.stderr)
        sys.exit(1)
    
    input_file = sys.argv[1]
    target_duration = float(sys.argv[2])
    output_file = sys.argv[3]
    
    sys.exit(time_stretch_audio(input_file, target_duration, output_file))
