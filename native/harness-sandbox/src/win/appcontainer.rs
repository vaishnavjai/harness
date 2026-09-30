//! The AppContainer profile and the capabilities the policy's network mode maps to.

use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Foundation::{LocalFree, ERROR_ALREADY_EXISTS, HLOCAL};
use windows::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows::Win32::Security::{FreeSid, PSID, SID_AND_ATTRIBUTES};

use super::{wide, Error};
use crate::policy::Network;

/// `SE_GROUP_ENABLED`: the capability is switched on in the token.
const SE_GROUP_ENABLED: u32 = 0x0000_0004;
/// Well-known capability SIDs (`S-1-15-3-x`).
const INTERNET_CLIENT: &str = "S-1-15-3-1";
const INTERNET_CLIENT_SERVER: &str = "S-1-15-3-2";

enum Owner {
    /// Returned by the AppContainer APIs, freed with `FreeSid`.
    Api,
    /// Returned by `ConvertStringSidToSidW`, freed with `LocalFree`.
    Local,
}

/// A SID that frees itself.
pub struct Sid {
    pub psid: PSID,
    owner: Owner,
}

impl Drop for Sid {
    fn drop(&mut self) {
        // SAFETY: `psid` came from the API named by `owner` and is freed exactly once, here.
        unsafe {
            match self.owner {
                Owner::Api => {
                    FreeSid(self.psid);
                }
                Owner::Local => {
                    LocalFree(Some(HLOCAL(self.psid.0)));
                }
            }
        }
    }
}

impl Sid {
    /// The `S-1-15-2-...` form, for logs and for `icacls`.
    pub fn to_string(&self) -> Result<String, Error> {
        let mut text = windows::core::PWSTR::null();
        // SAFETY: `psid` is a valid SID; on success `text` holds a LocalAlloc'd string freed below.
        unsafe { ConvertSidToStringSidW(self.psid, &mut text) }
            .map_err(|e| Error::new("sid text", e))?;
        // SAFETY: `text` is a NUL-terminated wide string returned by the call above.
        let result = unsafe { text.to_string() }.map_err(|e| Error::new("sid text", e));
        // SAFETY: allocated by ConvertSidToStringSidW with LocalAlloc.
        unsafe { LocalFree(Some(HLOCAL(text.0.cast()))) };
        result
    }
}

/// The SID of the container named `name`, creating the profile the first time.
pub fn profile_sid(name: &str) -> Result<Sid, Error> {
    let (name, display, description) = (
        wide(name),
        wide("Harness agent shell"),
        wide(
            "Runs the commands an agent starts, with no rights beyond the folders Harness grants.",
        ),
    );
    let (name, display, description) = (
        PCWSTR(name.as_ptr()),
        PCWSTR(display.as_ptr()),
        PCWSTR(description.as_ptr()),
    );
    // SAFETY: the three strings are NUL-terminated and outlive the calls.
    unsafe {
        match CreateAppContainerProfile(name, display, description, None) {
            Ok(psid) => Ok(Sid {
                psid,
                owner: Owner::Api,
            }),
            Err(e) if e.code() == HRESULT::from_win32(ERROR_ALREADY_EXISTS.0) => {
                DeriveAppContainerSidFromAppContainerName(name)
                    .map(|psid| Sid {
                        psid,
                        owner: Owner::Api,
                    })
                    .map_err(|e| Error::new("appcontainer profile", e))
            }
            Err(e) => Err(Error::new("appcontainer profile", e)),
        }
    }
}

/// The capability SIDs for a network mode, ready for `SECURITY_CAPABILITIES`. No capability means no network.
pub struct Capabilities {
    _sids: Vec<Sid>,
    pub entries: Vec<SID_AND_ATTRIBUTES>,
}

pub fn capabilities(network: Network) -> Result<Capabilities, Error> {
    let wanted: &[&str] = match network {
        Network::None => &[],
        Network::Internet => &[INTERNET_CLIENT],
        Network::InternetServer => &[INTERNET_CLIENT, INTERNET_CLIENT_SERVER],
    };
    let mut sids = Vec::new();
    for text in wanted {
        let wide_text = wide(text);
        let mut psid = PSID::default();
        // SAFETY: `wide_text` is NUL-terminated; `psid` receives a LocalAlloc'd SID that `Sid` frees.
        unsafe { ConvertStringSidToSidW(PCWSTR(wide_text.as_ptr()), &mut psid) }
            .map_err(|e| Error::new("network capability", e))?;
        sids.push(Sid {
            psid,
            owner: Owner::Local,
        });
    }
    let entries = sids
        .iter()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.psid,
            Attributes: SE_GROUP_ENABLED,
        })
        .collect();
    Ok(Capabilities {
        _sids: sids,
        entries,
    })
}
