use soroban_sdk::{Address, String as SorobanString, Bytes};

/// Oracle attestation for delivery confirmation
#[derive(Clone, Debug)]
pub struct OracleAttestation {
    /// Escrow ID being attested
    pub escrow_id: SorobanString,
    /// Oracle's Stellar address
    pub oracle: Address,
    /// Delivery status: true = success, false = failed
    pub delivery_success: bool,
    /// Reference to delivery proof (bank txn, mobile receipt, etc.)
    pub delivery_proof: SorobanString,
    /// Timestamp of attestation (Unix seconds)
    pub attestation_timestamp: u64,
    /// Oracle's cryptographic signature (Ed25519)
    pub signature: Bytes,
    /// Nonce to prevent replay attacks
    pub nonce: u64,
}

impl OracleAttestation {
    pub fn new(
        escrow_id: SorobanString,
        oracle: Address,
        delivery_success: bool,
        delivery_proof: SorobanString,
        attestation_timestamp: u64,
        signature: Bytes,
        nonce: u64,
    ) -> Self {
        OracleAttestation {
            escrow_id,
            oracle,
            delivery_success,
            delivery_proof,
            attestation_timestamp,
            signature,
            nonce,
        }
    }

    /// Verify the attestation signature (to be called by contract)
    /// In production, this uses Stellar's ed25519_verify precompile
    pub fn verify_signature(&self, env: &soroban_sdk::Env) -> bool {
        // Construct the message to verify
        let msg = format_attestation_message(
            &self.escrow_id,
            self.delivery_success,
            &self.delivery_proof,
            self.attestation_timestamp,
            self.nonce,
        );

        // Use Soroban's crypto verification (ed25519_verify)
        // This is a placeholder; the actual call is:
        // soroban_sdk::crypto::Ed25519::verify(&self.oracle, &msg, &self.signature)
        // We'll implement this in the contract invocation logic.
        true
    }
}

fn format_attestation_message(
    escrow_id: &SorobanString,
    delivery_success: bool,
    delivery_proof: &SorobanString,
    timestamp: u64,
    nonce: u64,
) -> Vec<u8> {
    // Construct deterministic message for signing
    // Format: "AFROPAY_ATTESTATION|escrow_id|success|proof|timestamp|nonce"
    let mut msg = vec![];
    msg.extend_from_slice(b"AFROPAY_ATTESTATION|");
    msg.extend_from_slice(escrow_id.as_bytes());
    msg.extend_from_slice(b"|");
    msg.extend_from_slice(if delivery_success { b"true" } else { b"false" });
    msg.extend_from_slice(b"|");
    msg.extend_from_slice(delivery_proof.as_bytes());
    msg.extend_from_slice(b"|");
    msg.extend_from_slice(timestamp.to_string().as_bytes());
    msg.extend_from_slice(b"|");
    msg.extend_from_slice(nonce.to_string().as_bytes());
    msg
}
