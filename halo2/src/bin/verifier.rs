use std::{fs::File, io::Read, path::PathBuf};

use anyhow::Result;
use clap::Parser;
use halo2_proofs::{
    plonk::verify_proof,
    poly::commitment::ParamsProver,
    poly::kzg::{
        commitment::KZGCommitmentScheme, multiopen::VerifierGWC, strategy::SingleStrategy,
    },
    transcript::{Blake2bRead, Challenge255, TranscriptReadBuffer},
};
use halo2curves::bn256::{Bn256, Fr, G1Affine};

use folding_halo2::{circuit::FoldedCircuit, keys::load_params_and_vk, load_public_inputs};

#[derive(Parser, Debug)]
#[command(version, about = "Halo2 verifier for folded blocks")]
struct Args {
    #[arg(long = "proof")]
    proof: PathBuf,
    #[arg(long = "public-inputs")]
    public_inputs: PathBuf,
    #[arg(long = "verification-key")]
    verification_key: PathBuf,
}

fn main() -> Result<()> {
    let args = Args::parse();

    let public_inputs = load_public_inputs(&args.public_inputs)?;
    let instances = public_inputs.to_field_elements()?;
    let blank = FoldedCircuit::blank(instances.len());
    let instance_container = vec![instances];
    let instance_refs: Vec<&[Fr]> = instance_container.iter().map(|v| v.as_slice()).collect();
    let circuit_instances: Vec<&[&[Fr]]> = vec![&instance_refs[..]];

    let (params, vk) = load_params_and_vk(&args.verification_key, &blank)?;
    let params_verifier = params.verifier_params();
    let strategy = SingleStrategy::new(params_verifier);

    let mut proof_bytes = Vec::new();
    File::open(&args.proof)?.read_to_end(&mut proof_bytes)?;

    let mut transcript = Blake2bRead::<_, G1Affine, Challenge255<_>>::init(&proof_bytes[..]);

    verify_proof::<
        KZGCommitmentScheme<Bn256>,
        VerifierGWC<'_, Bn256>,
        Challenge255<G1Affine>,
        Blake2bRead<&[u8], G1Affine, Challenge255<G1Affine>>,
        SingleStrategy<'_, Bn256>,
    >(
        params_verifier,
        &vk,
        strategy,
        &circuit_instances,
        &mut transcript,
    )?;

    Ok(())
}
