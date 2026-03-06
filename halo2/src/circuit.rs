use halo2_proofs::{
    circuit::{Layouter, Region, SimpleFloorPlanner, Value},
    plonk::{Advice, Circuit, Column, ConstraintSystem, Error, Instance, Selector},
    poly::Rotation,
};
use halo2curves::bn256::Fr;

#[derive(Clone, Debug)]
pub struct FoldedConfig {
    advice: Column<Advice>,
    commit_advice: Column<Advice>,
    instance: Column<Instance>,
    diff_selector: Selector,
    sum_selector: Selector,
}

#[derive(Clone, Debug, Default)]
pub struct FoldedCircuit {
    pub public_inputs: Vec<Fr>,
    pub folded_vectors: Vec<Vec<Fr>>,
    pub pq_vectors: Vec<Vec<Fr>>,
    pub epsilon_squared: Vec<Fr>,
    pub commitments: [Fr; 3],
}

impl FoldedCircuit {
    pub fn blank(len: usize) -> Self {
        Self {
            public_inputs: vec![Fr::from(0); len],
            folded_vectors: vec![],
            pq_vectors: vec![],
            epsilon_squared: vec![],
            commitments: [Fr::zero(); 3],
        }
    }
}

impl Circuit<Fr> for FoldedCircuit {
    type Config = FoldedConfig;
    type FloorPlanner = SimpleFloorPlanner;
    type Params = ();

    fn without_witnesses(&self) -> Self {
        Self::blank(self.public_inputs.len())
    }

    fn params(&self) -> Self::Params {
        ()
    }

    fn configure(meta: &mut ConstraintSystem<Fr>) -> Self::Config {
        let advice = meta.advice_column();
        let commit_advice = meta.advice_column();
        let instance = meta.instance_column();
        let diff_selector = meta.selector();
        let sum_selector = meta.selector();
        meta.enable_equality(advice);
        meta.enable_equality(commit_advice);
        meta.enable_equality(instance);
        meta.create_gate("folded_diff", |meta| {
            let s = meta.query_selector(diff_selector);
            let folded = meta.query_advice(advice, Rotation::cur());
            let pq = meta.query_advice(advice, Rotation::next());
            let diff = meta.query_advice(advice, Rotation(2));
            vec![s * (folded - pq - diff)]
        });
        meta.create_gate("epsilon_check", |meta| {
            let s = meta.query_selector(sum_selector);
            let value = meta.query_advice(advice, Rotation::cur());
            vec![s * value]
        });
        FoldedConfig {
            advice,
            commit_advice,
            instance,
            diff_selector,
            sum_selector,
        }
    }

    fn synthesize(
        &self,
        config: Self::Config,
        mut layouter: impl Layouter<Fr>,
    ) -> Result<(), Error> {
        let commit_advice = config.commit_advice;
        let instance = config.instance;
        layouter.assign_region(
            || "commitment equality",
            |mut region| {
                for (idx, commitment) in self.commitments.iter().enumerate() {
                    let private =
                        region.assign_advice(commit_advice, idx * 2, Value::known(*commitment));
                    let public = region.assign_advice_from_instance(
                        || "commitment_public",
                        instance,
                        idx,
                        commit_advice,
                        idx * 2 + 1,
                    )?;
                    region.constrain_equal(private.cell(), public.cell());
                }
                Ok(())
            },
        )?;

        if !self.folded_vectors.is_empty()
            && self.folded_vectors.len() == self.pq_vectors.len()
            && self.folded_vectors.len() == self.epsilon_squared.len()
        {
            let batches = self
                .folded_vectors
                .iter()
                .zip(self.pq_vectors.iter())
                .zip(self.epsilon_squared.iter());
            for (batch_idx, ((folded, pq), epsilon)) in batches.enumerate() {
                enforce_component_difference(
                    &mut layouter,
                    &config,
                    folded,
                    pq,
                    *epsilon,
                    batch_idx,
                )?;
            }
        }

        Ok(())
    }
}

fn enforce_component_difference(
    layouter: &mut impl Layouter<Fr>,
    config: &FoldedConfig,
    folded: &[Fr],
    pq: &[Fr],
    epsilon_squared: Fr,
    batch_idx: usize,
) -> Result<(), Error> {
    if folded.len() != pq.len() {
        return Err(Error::Synthesis);
    }
    let pairs: Vec<_> = folded.iter().zip(pq.iter()).collect();
    layouter.assign_region(
        || format!("diff_batch_{batch_idx}"),
        |mut region: Region<'_, Fr>| {
            let mut offset = 0;
            let mut sum = Fr::zero();
            for (_idx, (a, b)) in pairs.iter().enumerate() {
                let diff = **a - **b;
                sum += diff.square();
                region.assign_advice(config.advice, offset, Value::known(**a));
                region.assign_advice(config.advice, offset + 1, Value::known(**b));
                region.assign_advice(config.advice, offset + 2, Value::known(diff));
                config.diff_selector.enable(&mut region, offset)?;
                offset += 3;
            }
            let diff_val = sum - epsilon_squared;
            if diff_val != Fr::zero() {
                println!(
                    "epsilon mismatch batch {}: sum {:?} != epsilon {:?}",
                    batch_idx, sum, epsilon_squared
                );
            }
            region.assign_advice(config.advice, offset, Value::known(diff_val));
            config.sum_selector.enable(&mut region, offset)?;
            Ok(())
        },
    )
}

