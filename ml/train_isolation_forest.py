#!/usr/bin/env python3
"""
Train an Isolation Forest model on block fingerprints.

Usage:
    python train_isolation_forest.py [--input PATH] [--output PATH] [--contamination FLOAT]

The model learns what "normal" block fingerprints look like, then assigns
anomaly scores to new blocks based on how isolated they are in the feature space.
"""

import json
import argparse
import numpy as np
from pathlib import Path
from sklearn.ensemble import IsolationForest
import joblib
from datetime import datetime


def load_training_data(input_path: str, max_samples: int = 50000) -> np.ndarray:
    """Load fingerprints from JSONL file and flatten to 96-dim vectors."""
    vectors = []
    
    with open(input_path, 'r') as f:
        for i, line in enumerate(f):
            if i >= max_samples:
                break
            try:
                record = json.loads(line.strip())
                # Each block has ~6 vectors of 16 dims
                # Flatten to single 96-dim fingerprint
                block_vectors = record.get('vectors', [])
                if block_vectors:
                    flat = np.array(block_vectors).flatten()
                    # Pad or truncate to 96 dims
                    if len(flat) < 96:
                        flat = np.pad(flat, (0, 96 - len(flat)), mode='constant')
                    elif len(flat) > 96:
                        flat = flat[:96]
                    vectors.append(flat)
            except (json.JSONDecodeError, KeyError) as e:
                continue
    
    print(f"[train] Loaded {len(vectors)} fingerprints from {input_path}")
    return np.array(vectors)


def train_model(X: np.ndarray, contamination: float = 0.05) -> IsolationForest:
    """Train Isolation Forest model."""
    print(f"[train] Training Isolation Forest (contamination={contamination}, samples={len(X)})")
    
    model = IsolationForest(
        n_estimators=100,
        contamination=contamination,
        max_samples='auto',
        max_features=1.0,
        bootstrap=False,
        n_jobs=-1,
        random_state=42,
        verbose=1
    )
    
    model.fit(X)
    print("[train] Training complete")
    return model


def export_model(model: IsolationForest, output_path: str, metadata: dict):
    """Export model and metadata."""
    output_dir = Path(output_path).parent
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Save sklearn model
    model_path = output_path
    joblib.dump(model, model_path)
    print(f"[train] Saved model to {model_path}")
    
    # Save metadata
    meta_path = str(Path(output_path).with_suffix('.json'))
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"[train] Saved metadata to {meta_path}")
    
    return model_path, meta_path


def compute_threshold_stats(model: IsolationForest, X: np.ndarray) -> dict:
    """Compute score statistics for threshold calibration."""
    scores = -model.score_samples(X)  # Higher = more anomalous
    
    return {
        'mean': float(np.mean(scores)),
        'std': float(np.std(scores)),
        'min': float(np.min(scores)),
        'max': float(np.max(scores)),
        'p50': float(np.percentile(scores, 50)),
        'p90': float(np.percentile(scores, 90)),
        'p95': float(np.percentile(scores, 95)),
        'p99': float(np.percentile(scores, 99)),
    }


def main():
    parser = argparse.ArgumentParser(description='Train Isolation Forest on block fingerprints')
    parser.add_argument('--input', type=str, default='artifacts/training/foldedVectors.jsonl',
                       help='Path to training data (JSONL)')
    parser.add_argument('--output', type=str, default='ml/models/isolation_forest.joblib',
                       help='Path to save trained model')
    parser.add_argument('--contamination', type=float, default=0.05,
                       help='Expected proportion of anomalies (0.01-0.1)')
    parser.add_argument('--max-samples', type=int, default=50000,
                       help='Maximum training samples to use')
    
    args = parser.parse_args()
    
    # Load data
    X = load_training_data(args.input, args.max_samples)
    if len(X) < 100:
        print(f"[train] ERROR: Not enough training data ({len(X)} samples)")
        return 1
    
    # Train model
    model = train_model(X, args.contamination)
    
    # Compute stats
    stats = compute_threshold_stats(model, X)
    print(f"[train] Score stats: mean={stats['mean']:.4f}, p95={stats['p95']:.4f}, p99={stats['p99']:.4f}")
    
    # Export
    metadata = {
        'model_type': 'IsolationForest',
        'trained_at': datetime.utcnow().isoformat(),
        'input_dims': 96,
        'n_estimators': 100,
        'contamination': args.contamination,
        'training_samples': len(X),
        'score_stats': stats,
        'threshold_suggestion': stats['p95'],  # Scores above this are anomalous
    }
    
    export_model(model, args.output, metadata)
    
    print("[train] Done!")
    return 0


if __name__ == '__main__':
    exit(main())

