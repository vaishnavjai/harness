//! Granting the container access to a folder by adding an ACE for its SID to the folder's DACL.
//!
//! The ACE is inheritable, so files created inside later carry it. Adding it makes Windows push it onto every
//! existing child, which is slow on a large tree, so a grant that is already in place is left alone: the
//! cost is paid once per folder, not once per command.

use std::ptr::null_mut;

use windows::core::{HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL, WIN32_ERROR};
use windows::Win32::Security::Authorization::{
    GetExplicitEntriesFromAclW, GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW,
    ACCESS_MODE, EXPLICIT_ACCESS_W, GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SET_ACCESS,
    SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    EqualSid, ACL, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows::Win32::Storage::FileSystem::{
    DELETE, FILE_DELETE_CHILD, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
};

use super::appcontainer::Sid;
use super::{wide, Error};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    ReadWrite,
    ReadOnly,
}

/// Read, write, run and delete inside the folder. WRITE_DAC and WRITE_OWNER are left out, so the sandbox
/// cannot rewrite the permissions that confine it.
fn mask(access: Access) -> u32 {
    let read_run = FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0;
    match access {
        Access::ReadOnly => read_run,
        Access::ReadWrite => read_run | FILE_GENERIC_WRITE.0 | DELETE.0 | FILE_DELETE_CHILD.0,
    }
}

/// Read and write on a device object such as `\\.\NUL`. Not inheritable: a device has no children.
pub fn grant_device(path: &str, sid: &Sid) -> Result<(), Error> {
    edit(
        path,
        sid,
        FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
        SET_ACCESS,
        true,
    )
}

pub fn grant(path: &str, sid: &Sid, access: Access) -> Result<(), Error> {
    edit(path, sid, mask(access), SET_ACCESS, true)
}

pub fn revoke(path: &str, sid: &Sid) -> Result<(), Error> {
    edit(path, sid, 0, REVOKE_ACCESS, false)
}

fn check(step: &'static str, path: &str, status: WIN32_ERROR) -> Result<(), Error> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(Error::new(
            step,
            format!(
                "{path}: {}",
                windows::core::Error::from_hresult(HRESULT::from_win32(status.0))
            ),
        ))
    }
}

/// Owns memory the security APIs allocated with LocalAlloc.
struct Local<T>(*mut T);

impl<T> Drop for Local<T> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the pointer came from a security API documented to allocate with LocalAlloc.
            unsafe { LocalFree(Some(HLOCAL(self.0.cast()))) };
        }
    }
}

fn edit(
    path: &str,
    sid: &Sid,
    mask: u32,
    mode: ACCESS_MODE,
    skip_if_present: bool,
) -> Result<(), Error> {
    let wide_path = wide(path);
    let object = PCWSTR(wide_path.as_ptr());
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: `object` is NUL-terminated; the out-pointers are valid. `descriptor` owns the memory `dacl` points into.
    let status = unsafe {
        GetNamedSecurityInfoW(
            object,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        )
    };
    check("read folder permissions", path, status)?;
    let _descriptor = Local(descriptor.0);

    if skip_if_present && already_granted(dacl, sid, mask) {
        return Ok(());
    }

    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: PWSTR(sid.psid.0.cast()),
        },
    };
    let mut merged: *mut ACL = null_mut();
    // SAFETY: `entry` and the old DACL are valid for the call; `merged` receives a LocalAlloc'd ACL.
    let status = unsafe { SetEntriesInAclW(Some(&[entry]), Some(dacl), &mut merged) };
    check("build folder permissions", path, status)?;
    let merged = Local(merged);
    // SAFETY: `object` is NUL-terminated and `merged` is a valid ACL.
    let status = unsafe {
        SetNamedSecurityInfoW(
            object,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(merged.0),
            None,
        )
    };
    check("grant folder access", path, status)
}

/// True when the DACL already holds an inheritable allow entry for the container with at least these rights.
fn already_granted(dacl: *mut ACL, sid: &Sid, mask: u32) -> bool {
    if dacl.is_null() {
        return false;
    }
    let mut count = 0u32;
    let mut entries: *mut EXPLICIT_ACCESS_W = null_mut();
    // SAFETY: `dacl` is a valid ACL from GetNamedSecurityInfoW; `entries` receives a LocalAlloc'd array of `count`.
    let status = unsafe { GetExplicitEntriesFromAclW(dacl, &mut count, &mut entries) };
    if status != ERROR_SUCCESS {
        return false;
    }
    let entries = Local(entries);
    // SAFETY: the array has `count` initialised elements and lives until `entries` drops.
    let list = unsafe { std::slice::from_raw_parts(entries.0, count as usize) };
    list.iter().any(|entry| {
        entry.grfAccessMode == GRANT_ACCESS
            && entry.grfAccessPermissions & mask == mask
            && entry.grfInheritance.0 & SUB_CONTAINERS_AND_OBJECTS_INHERIT.0 == SUB_CONTAINERS_AND_OBJECTS_INHERIT.0
            && entry.Trustee.TrusteeForm == TRUSTEE_IS_SID
            // SAFETY: for a SID trustee `ptstrName` points at the SID; both pointers are valid SIDs.
            && unsafe { EqualSid(windows::Win32::Security::PSID(entry.Trustee.ptstrName.0.cast()), sid.psid) }.is_ok()
    })
}
