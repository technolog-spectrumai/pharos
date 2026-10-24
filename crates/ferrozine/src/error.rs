//! The one error type ferrozine returns.

use thiserror::Error;

/// Why a connection, a handshake or a transfer failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum Error {
    /// The iroh endpoint could not be bound.
    #[error("iroh bind failed: {0}")]
    Bind(String),
    /// Dialling, accepting or a stream operation failed.
    #[error("connection: {0}")]
    Connection(String),
    /// Reading or writing a stream failed.
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
    /// A frame was larger than its bound, malformed, or out of order.
    #[error("protocol: {0}")]
    Protocol(String),
    /// The MLS layer (rotor) refused an operation.
    #[error("mls: {0}")]
    Mls(String),
    /// The peer is not the one this transfer was authorized for.
    #[error("not authorized: {0}")]
    Unauthorized(String),
    /// The received bytes are incomplete or do not match what was sent.
    #[error("integrity: {0}")]
    Integrity(String),
    /// An address or other encoded value did not decode.
    #[error("decode: {0}")]
    Decode(String),
}

impl Error {
    pub(crate) fn conn(e: impl std::fmt::Display) -> Self {
        Self::Connection(e.to_string())
    }
}

/// Shorthand for results whose error is [`enum@Error`].
pub type Result<T> = std::result::Result<T, Error>;
