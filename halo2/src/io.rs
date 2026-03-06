use std::{fs::File, io::BufReader, path::Path};

use anyhow::Result;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct WitnessData {
    #[serde(rename = "foldedVectors")]
    pub folded_vectors: Vec<Vec<f64>>,
    #[serde(rename = "pqVectors")]
    pub pq_vectors: Vec<Vec<f64>>,
    #[serde(rename = "headerRlp")]
    pub header_rlp: Option<String>,
}

pub fn load_witness<P: AsRef<Path>>(path: P) -> Result<WitnessData> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let witness = serde_json::from_reader(reader)?;
    Ok(witness)
}
