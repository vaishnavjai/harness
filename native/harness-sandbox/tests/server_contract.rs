//! The policy file the Harness server writes must be one the helper accepts. The fixture is produced by the
//! server's own policy builder (`apps/server/src/agent-sandbox.test.ts` compares its output to this file), so a
//! change to either side that breaks the other fails a test on both.

use harness_sandbox::policy::{Network, Policy};

const FIXTURE: &str = include_str!("fixtures/server-policy.json");

fn sensitive() -> Vec<String> {
    [
        "C:\\Users\\me",
        "C:\\Users\\me\\AppData\\Roaming",
        "C:\\Users\\me\\AppData\\Local",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

#[test]
fn the_servers_policy_is_accepted_by_the_helper() {
    let policy = Policy::parse(FIXTURE).expect("the helper can parse what the server writes");
    let valid = policy
        .validate("C:", &sensitive())
        .expect("the helper accepts what the server writes");
    assert_eq!(valid.read_write, vec!["C:\\Users\\me\\proj", "D:\\work"]);
    assert_eq!(
        valid.read_only,
        vec![
            "C:\\Users\\me\\.bun\\bin",
            "C:\\Users\\me\\AppData\\Roaming\\npm"
        ]
    );
    assert_eq!(valid.network, Network::None);
    assert!(!valid.keep_background);
}

#[test]
fn a_fixture_that_grants_the_protected_folder_would_be_refused() {
    // The same file with the workspace moved onto Harness's own data: the helper must say no.
    let bad = FIXTURE.replace(
        "C:\\\\Users\\\\me\\\\proj",
        "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\harness\\\\data",
    );
    assert_ne!(bad, FIXTURE);
    let policy = Policy::parse(&bad).expect("still parses");
    assert!(policy.validate("C:", &sensitive()).is_err());
}
