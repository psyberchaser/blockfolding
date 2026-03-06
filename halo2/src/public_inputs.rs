use anyhow::Result;
use blake3::Hasher;
use halo2curves::{
    bn256::Fr,
    ff::Field,
};
use hex::FromHex;
use rand::SeedableRng;
use rand_chacha::ChaCha20Rng;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ParsedPublicInputs {
    #[serde(rename = "prevStateRoot")]
    pub prev_state_root: String,
    #[serde(rename = "newStateRoot")]
    pub new_state_root: String,
    #[serde(rename = "blockHeight")]
    pub block_height: u64,
    #[serde(rename = "txMerkleRoot")]
    pub tx_merkle_root: String,
    #[serde(rename = "foldedCommitment")]
    pub folded_commitment: String,
    #[serde(rename = "pqCommitment")]
    pub pq_commitment: String,
    #[serde(rename = "codebookRoot")]
    pub codebook_root: String,
}

pub fn load_public_inputs(path: impl AsRef<std::path::Path>) -> Result<ParsedPublicInputs> {
    let file = std::fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);
    let public_inputs = serde_json::from_reader(reader)?;
    Ok(public_inputs)
}

impl ParsedPublicInputs {
    pub fn to_field_elements(&self) -> Result<Vec<Fr>> {
        Ok(vec![
            hex_to_field(&self.folded_commitment)?,
            hex_to_field(&self.pq_commitment)?,
            hex_to_field(&self.codebook_root)?,
        ])
    }

    pub fn commitment_fields(&self) -> Result<[Fr; 3]> {
        Ok([
            hex_to_field(&self.folded_commitment)?,
            hex_to_field(&self.pq_commitment)?,
            hex_to_field(&self.codebook_root)?,
        ])
    }
}

fn hex_to_field(hex_str: &str) -> Result<Fr> {
    let normalized = hex_str.trim_start_matches("0x").trim_start_matches("0X");
    let bytes = Vec::from_hex(normalized)?;
    let seed = if bytes.is_empty() {
        [0u8; 32]
    } else {
        let mut hasher = Hasher::new();
        hasher.update(&bytes);
        let hash = hasher.finalize();
        let mut out = [0u8; 32];
        out.copy_from_slice(hash.as_bytes());
        out
    };
    let mut rng = ChaCha20Rng::from_seed(seed);
    Ok(Fr::random(&mut rng))
}

