#!/usr/bin/env python3
"""Compute mean and std vectors from training data and update model metadata."""

import json
import numpy as np
from pathlib import Path

def main():
    input_path = 'artifacts/training/foldedVectors.jsonl'
    metadata_path = 'ml/models/isolation_forest.json'
    
    # Load fingerprints
    vectors = []
    with open(input_path, 'r') as f:
        for i, line in enumerate(f):
            if i >= 30000:
                break
            try:
                record = json.loads(line.strip())
                block_vectors = record.get('vectors', [])
                if block_vectors:
                    flat = np.array(block_vectors).flatten()
                    if len(flat) < 96:
                        flat = np.pad(flat, (0, 96 - len(flat)), mode='constant')
                    elif len(flat) > 96:
                        flat = flat[:96]
                    vectors.append(flat)
            except:
                continue
    
    X = np.array(vectors)
    print(f"Loaded {len(X)} fingerprints")
    
    # Compute stats
    mean_vector = X.mean(axis=0).tolist()
    std_vector = X.std(axis=0).tolist()
    
    # Update metadata
    with open(metadata_path, 'r') as f:
        metadata = json.load(f)
    
    metadata['mean_vector'] = mean_vector
    metadata['std_vector'] = std_vector
    
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    
    print(f"Updated {metadata_path} with mean/std vectors")
    print(f"Mean range: [{min(mean_vector):.4f}, {max(mean_vector):.4f}]")
    print(f"Std range: [{min(std_vector):.4f}, {max(std_vector):.4f}]")

if __name__ == '__main__':
    main()

