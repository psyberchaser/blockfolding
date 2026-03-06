use std::{fs::File, path::Path};

use anyhow::{Context, Result};
use halo2_proofs::{
    plonk::{keygen_pk, keygen_vk, ProvingKey, VerifyingKey},
    poly::kzg::commitment::ParamsKZG,
};
use halo2curves::bn256::{Bn256, G1Affine};
use rand::{rngs::OsRng, RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use serde::{Deserialize, Serialize};
use serde_json;

use crate::FoldedCircuit;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct KeyConfig {
    circuit_k: u32,
    seed: [u8; 32],
}

pub fn load_or_init_keys(
    proving_path: &Path,
    verifying_path: &Path,
    requested_k: u32,
    blank_circuit: &FoldedCircuit,
) -> Result<(ParamsKZG<Bn256>, ProvingKey<G1Affine>)> {
    let config = load_or_create_config(proving_path, requested_k)?;
    ensure_config(verifying_path, &config)?;
    build_params_and_pk(&config, blank_circuit)
}

pub fn load_params_and_vk(
    verifying_path: &Path,
    blank_circuit: &FoldedCircuit,
) -> Result<(ParamsKZG<Bn256>, VerifyingKey<G1Affine>)> {
    let config = read_config(verifying_path)?;
    build_params_and_vk(&config, blank_circuit)
}

fn build_params_and_pk(
    config: &KeyConfig,
    blank_circuit: &FoldedCircuit,
) -> Result<(ParamsKZG<Bn256>, ProvingKey<G1Affine>)> {
    let mut rng = ChaCha20Rng::from_seed(config.seed);
    let params = ParamsKZG::<Bn256>::setup(config.circuit_k, &mut rng);
    let vk = keygen_vk(&params, blank_circuit)?;
    let pk = keygen_pk(&params, vk, blank_circuit)?;
    Ok((params, pk))
}

fn build_params_and_vk(
    config: &KeyConfig,
    blank_circuit: &FoldedCircuit,
) -> Result<(ParamsKZG<Bn256>, VerifyingKey<G1Affine>)> {
    let mut rng = ChaCha20Rng::from_seed(config.seed);
    let params = ParamsKZG::<Bn256>::setup(config.circuit_k, &mut rng);
    let vk = keygen_vk(&params, blank_circuit)?;
    Ok((params, vk))
}

fn load_or_create_config(path: &Path, requested_k: u32) -> Result<KeyConfig> {
    if path.exists() {
        let config = read_config(path)?;
        if config.circuit_k != requested_k {
            anyhow::bail!(
                "Existing proving key config uses k={}, requested {}",
                config.circuit_k,
                requested_k
            );
        }
        Ok(config)
    } else {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        let config = KeyConfig {
            circuit_k: requested_k,
            seed,
        };
        write_config(path, &config)?;
        Ok(config)
    }
}

fn ensure_config(path: &Path, config: &KeyConfig) -> Result<()> {
    if path.exists() {
        let existing = read_config(path)?;
        if existing.circuit_k != config.circuit_k || existing.seed != config.seed {
            anyhow::bail!("Verifier key config mismatch");
        }
        Ok(())
    } else {
        write_config(path, config)
    }
}

fn read_config(path: &Path) -> Result<KeyConfig> {
    let file = File::open(path).with_context(|| format!("opening {:?}", path))?;
    Ok(serde_json::from_reader(file)?)
}

fn write_config(path: &Path, config: &KeyConfig) -> Result<()> {
    let file = File::create(path)?;
    serde_json::to_writer_pretty(file, config)?;
    Ok(())
}
