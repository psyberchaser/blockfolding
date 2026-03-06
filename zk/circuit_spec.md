## Folded Block ZK Circuit (Draft)

### Public Inputs

| Signal | Description |
| --- | --- |
| `prev_state_root` | State root before executing the block |
| `new_state_root` | State root after executing the block |
| `block_height` | Height of the sealed block |
| `tx_merkle_root` | Commitment to the raw transaction list |
| `folded_commitment` | Poseidon/BLAKE hash of the folded vectors |
| `pq_commitment` | Poseidon/BLAKE hash of the PQ indices |
| `codebook_root` | Merkle/poseidon root of PQ centroids |

### Witnesses

- Full transaction list and execution traces (or succinct state diff).
- Witness payloads required by the execution prover (constraints, gates, etc.).
- Intermediate fold vectors `F_B`.
- PQ indices per folded vector prior to hashing.

### Constraint System Overview

1. **State Transition Gadget**  
   - Applies each transaction to the `prev_state_root`.  
   - Replays execution traces / state diffs and checks the resulting root equals `new_state_root`.

2. **Vectorization Gadget**  
   - Mirrors `vectorizeBlock` using fixed-point arithmetic.  
   - Ensures every raw tx / state / witness tuple maps to deterministic vectors `{x_i}`.

3. **Folding Gadget**  
   - Applies the linear/piecewise-linear folding operator `F`.  
   - Outputs block-level vectors.  
   - Hashes them with Poseidon/BLAKE → `folded_commitment`.

4. **PQ Gadget**  
   - Splits each folded vector into `m` subvectors.  
   - Looks up centroids from the codebook (via fixed root).  
   - Enforces reconstruction error ≤ ε (L2, configurable; default 1.5 off-chain, 1.0 target in-circuit).  
   - Hashes indices → `pq_commitment`.

5. **Consistency Checks**  
   - Every path uses identical rounding rules as the off-chain implementation.  
   - Optional: expose error margins + per-component diagnostics as internal signals to aid analytics circuits.

### Fixed-Point Layout

- **Feature normalization:** `vectorizeBlock` already clamps each component to `[-1, 1]`. Inside the circuit we encode every scalar as signed Q2.14 (16-bit) for the early gadgets, then upcast to Q4.28 when computing stats and folding so dot products do not overflow the bn254 field.
- **Folding stats:** means/variances use Q8.24 accumulators with deterministic rounding (`round_towards_zero`). Variance square roots are approximated via table lookup + one Newton iteration in Q4.28.
- **Component builder:** the pseudo-components (currently sin/cos weighted sums) will be replaced by a fixed `k × d` matrix with entries in Q2.14. This keeps the folding operator fully linear and circuited as a matrix multiply gadget.
- **PQ tolerance:** off-chain `pqEncode` enforces `||x - \hat{x}||₂ ≤ ε` with ε supplied via CLI/tests. We aim for ε ≤ 1.0 once the codebook is tuned; the circuit will implement the same constraint via range-checked accumulators (summing squared differences in Q6.26, then comparing against ε²).

### Halo2 Integration Plan

1. **Gadgets**
   - Reuse existing Halo2 range-check tables for Q2.14/Q4.28 encodings.
   - Implement a `LinearFold` chip parameterized by the folding matrix.
   - Implement a `PQLookup` chip: each centroid lives in a commitment table keyed by (`subspace_index`, `centroid_index`). We constrain the lookup result and subtract it from the folded vector slice, enforcing the ε bound described above.
   - Hash gadgets: Poseidon for in-circuit commitments + optional BLAKE3 hashing outside (for compatibility with existing L1 contracts).
2. **Backend plumbing**
   - `halo2Backend.ts` now shells out to real Halo2 binaries: witness + public input JSON in, proof bytes out. When the circuit is ready, point `proverCommand`/`verifierCommand` to the compiled binary and the `pipeline` CLI can produce real proofs instead of using `mockBackend`.
3. **Recursive composition**
   - The folding proof can wrap an execution proof at a later stage via Halo2's aggregation gadgets. For now we focus on a single circuit; aggregation hooks (public inputs referencing the inner proof commitment) stay on the roadmap.

### Open Questions

1. How to manage codebook rotation/versioning so light clients know which `codebook_root` to expect (on-chain registry vs. hard-coded constant).  
2. Whether to expose KDE / analytics attestations inside the same proof or keep them off-circuit.  
3. How aggressive we can be when shrinking ε without exploding prover time (empirically tuned via `scripts/runPipeline.ts --pq-error ...`).

