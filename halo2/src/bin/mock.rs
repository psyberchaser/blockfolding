use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use halo2_proofs::dev::MockProver;
use halo2curves::bn256::Fr;

use folding_halo2::{circuit::FoldedCircuit, io::load_witness, load_public_inputs};

#[derive(Parser, Debug)]
#[command(version, about = "Mock prover for folded circuit")]
struct Args {
    #[arg(long)]
    witness: PathBuf,
    #[arg(long = "public-inputs")]
    public_inputs: PathBuf,
    #[arg(long = "circuit-k", default_value_t = 12)]
    circuit_k: u32,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let witness = load_witness(&args.witness)?;
    let public_inputs = load_public_inputs(&args.public_inputs)?;
    let instances = public_inputs.to_field_elements()?;
    let commitments = public_inputs.commitment_fields()?;

    let folded = to_field_matrix(&witness.folded_vectors);
    let pq = to_field_matrix(&witness.pq_vectors);
    let epsilon = compute_field_residuals(&folded, &pq);

    let circuit = FoldedCircuit {
        public_inputs: instances.clone(),
        folded_vectors: folded,
        pq_vectors: pq,
        epsilon_squared: epsilon,
        commitments,
    };

    let prover = MockProver::run(args.circuit_k, &circuit, vec![instances])?;
    prover.assert_satisfied();
    println!("Mock prover satisfied");
    Ok(())
}

fn to_field_matrix(input: &[Vec<f64>]) -> Vec<Vec<Fr>> {
    input
        .iter()
        .map(|row| row.iter().map(|value| float_to_field(*value)).collect())
        .collect()
}

fn float_to_field(value: f64) -> Fr {
    const SCALE: f64 = 1_000_000.0;
    let scaled = (value * SCALE).floor() as i64;
    from_i64(scaled) * scale_inv()
}

fn from_i64(value: i64) -> Fr {
    if value >= 0 {
        Fr::from(value as u64)
    } else {
        -Fr::from((-value) as u64)
    }
}

fn scale_inv() -> Fr {
    use std::sync::OnceLock;
    static INV: OnceLock<Fr> = OnceLock::new();
    *INV.get_or_init(|| {
        Fr::from(1_000_000u64)
            .invert()
            .expect("scale must have inverse in field")
    })
}

fn compute_field_residuals(folded: &[Vec<Fr>], pq: &[Vec<Fr>]) -> Vec<Fr> {
    folded
        .iter()
        .zip(pq.iter())
        .map(|(f_row, pq_row)| {
            f_row
                .iter()
                .zip(pq_row.iter())
                .fold(Fr::zero(), |acc, (a, b)| {
                    let diff = *a - *b;
                    acc + diff.square()
                })
        })
        .collect()
}

