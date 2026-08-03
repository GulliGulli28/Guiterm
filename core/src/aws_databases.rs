//! Discovering AWS-managed databases through the user's own `aws` CLI.
//!
//! Same footing as [`crate::aws_inventory`] — no SDK, no credentials of our
//! own — but pointed at the managed data stores instead of EC2. Every engine
//! AWS manages that this app already speaks has a counterpart here:
//! RDS/Aurora for MySQL and PostgreSQL, ElastiCache for Redis. Nothing new is
//! implemented; existing connections are discovered instead of typed.
//!
//! **What is deliberately *not* importable** is as much the point as what is.
//! A managed database this app cannot actually reach is listed with the reason
//! rather than hidden or, worse, imported into a connection that fails later:
//!
//! - Oracle and SQL Server — engines the app doesn't speak at all.
//! - DocumentDB — requires TLS signed by the Amazon RDS certificate authority,
//!   which is not in any system trust store and which this app does not carry.
//! - ElastiCache with encryption in transit — `crate::redis_client` dials
//!   `redis://` only, it has no TLS.
//!
//! Each of those is a real gap with a real fix; showing them is what makes the
//! gap actionable instead of mysterious.

use crate::aws_inventory::{AwsCliError, run_aws};
use crate::model::SqlEngine;
use serde::{Deserialize, Serialize};

/// One managed database, as the import panel needs to show it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsDatabase {
    /// AWS's own identifier — the cluster or instance name.
    pub identifier: String,
    /// Which AWS service it came from: `RDS`, `Aurora`, `ElastiCache`,
    /// `DocumentDB`. Shown as-is; it's how people refer to them.
    pub service: String,
    /// AWS's engine string, verbatim (`aurora-postgresql`, `docdb`, …).
    pub engine: String,
    pub engine_version: Option<String>,
    pub address: String,
    pub port: u16,
    /// The master username AWS reports, when it reports one.
    pub username: String,
    /// The database created with the instance, when there is one — PostgreSQL
    /// needs one to connect at all.
    pub initial_database: Option<String>,
    pub status: String,
    /// The app engine this maps onto. `None` means it cannot be imported, and
    /// [`Self::unsupported_reason`] says why.
    pub supported_engine: Option<SqlEngine>,
    pub unsupported_reason: Option<String>,
}

impl AwsDatabase {
    pub fn importable(&self) -> bool {
        self.supported_engine.is_some() && self.status == "available"
    }
}

/// Maps an AWS engine string onto an app engine, or explains the refusal.
///
/// The reasons are written for someone deciding what to do next, not as error
/// codes: each names the missing capability, because each is fixable and
/// knowing which one it is decides whether you reach for a parameter group or
/// for a different tool.
pub fn map_engine(engine: &str, transit_encryption: bool) -> (Option<SqlEngine>, Option<String>) {
    let engine = engine.to_ascii_lowercase();
    let unsupported = |reason: &str| (None, Some(reason.to_string()));

    if engine.contains("docdb") {
        return unsupported(
            "DocumentDB impose TLS signé par l'autorité de certification Amazon RDS, \
             que Guiterm n'embarque pas — la connexion échouerait à la négociation.",
        );
    }
    if engine.contains("oracle") || engine.contains("sqlserver") {
        return unsupported("Moteur non géré par Guiterm.");
    }
    if engine.contains("memcached") {
        return unsupported("Memcached n'est pas un moteur géré par Guiterm.");
    }
    if engine.contains("redis") || engine.contains("valkey") {
        if transit_encryption {
            return unsupported(
                "Chiffrement en transit activé sur ce cluster : le client Redis de Guiterm \
                 se connecte en clair (redis://) et ne sait pas encore faire de TLS.",
            );
        }
        return (Some(SqlEngine::Redis), None);
    }
    if engine.contains("postgres") {
        return (Some(SqlEngine::Postgres), None);
    }
    if engine.contains("mysql") || engine.contains("mariadb") {
        return (Some(SqlEngine::Mysql), None);
    }
    unsupported("Moteur non reconnu.")
}

fn text(value: &serde_json::Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// Parses `describe-db-clusters`, from either `aws rds` or `aws docdb` — the
/// two share the API shape, which is why one parser covers both.
///
/// Clusters are read *as well as* instances because an Aurora cluster's
/// endpoint is the one that follows a failover; an instance endpoint points at
/// one particular machine and stops being the writer without warning.
pub fn parse_clusters(json: &str, service: &str) -> Result<Vec<AwsDatabase>, AwsCliError> {
    let parsed: serde_json::Value = serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
        message: format!("réponse describe-db-clusters illisible : {e}"),
    })?;
    let mut out = Vec::new();
    let Some(clusters) = parsed["DBClusters"].as_array() else {
        return Ok(out);
    };
    for raw in clusters {
        let Some(identifier) = text(&raw["DBClusterIdentifier"]) else {
            continue;
        };
        let Some(address) = text(&raw["Endpoint"]) else {
            continue;
        };
        let engine = text(&raw["Engine"]).unwrap_or_default();
        let (supported_engine, unsupported_reason) = map_engine(&engine, false);
        out.push(AwsDatabase {
            identifier,
            service: service.to_string(),
            engine_version: text(&raw["EngineVersion"]),
            port: raw["Port"].as_u64().unwrap_or(0) as u16,
            username: text(&raw["MasterUsername"]).unwrap_or_default(),
            initial_database: text(&raw["DatabaseName"]),
            status: text(&raw["Status"]).unwrap_or_else(|| "unknown".to_string()),
            engine,
            address,
            supported_engine,
            unsupported_reason,
        });
    }
    Ok(out)
}

/// Parses `aws rds describe-db-instances`.
///
/// Instances belonging to a cluster are skipped: the cluster is already listed
/// from [`parse_clusters`] with the endpoint that survives a failover, and
/// offering both would invite importing the wrong one.
pub fn parse_instances(json: &str) -> Result<Vec<AwsDatabase>, AwsCliError> {
    let parsed: serde_json::Value = serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
        message: format!("réponse describe-db-instances illisible : {e}"),
    })?;
    let mut out = Vec::new();
    let Some(instances) = parsed["DBInstances"].as_array() else {
        return Ok(out);
    };
    for raw in instances {
        if text(&raw["DBClusterIdentifier"]).is_some() {
            continue;
        }
        let Some(identifier) = text(&raw["DBInstanceIdentifier"]) else {
            continue;
        };
        let Some(address) = text(&raw["Endpoint"]["Address"]) else {
            continue;
        };
        let engine = text(&raw["Engine"]).unwrap_or_default();
        let (supported_engine, unsupported_reason) = map_engine(&engine, false);
        out.push(AwsDatabase {
            identifier,
            service: "RDS".to_string(),
            engine_version: text(&raw["EngineVersion"]),
            port: raw["Endpoint"]["Port"].as_u64().unwrap_or(0) as u16,
            username: text(&raw["MasterUsername"]).unwrap_or_default(),
            initial_database: text(&raw["DBName"]),
            status: text(&raw["DBInstanceStatus"]).unwrap_or_else(|| "unknown".to_string()),
            engine,
            address,
            supported_engine,
            unsupported_reason,
        });
    }
    Ok(out)
}

/// Parses `aws elasticache describe-replication-groups`.
///
/// Replication groups rather than cache clusters: a group's primary endpoint
/// is the one that stays correct across a failover, and it's what every
/// non-trivial ElastiCache deployment is made of. Memcached has no replication
/// groups at all, so it simply never appears here — which is right, the app
/// doesn't speak it.
pub fn parse_replication_groups(json: &str) -> Result<Vec<AwsDatabase>, AwsCliError> {
    let parsed: serde_json::Value = serde_json::from_str(json).map_err(|e| AwsCliError::Unreadable {
        message: format!("réponse describe-replication-groups illisible : {e}"),
    })?;
    let mut out = Vec::new();
    let Some(groups) = parsed["ReplicationGroups"].as_array() else {
        return Ok(out);
    };
    for raw in groups {
        let Some(identifier) = text(&raw["ReplicationGroupId"]) else {
            continue;
        };
        // Cluster mode on exposes a single configuration endpoint; cluster
        // mode off exposes a primary endpoint per node group. Either is the
        // address to dial.
        let endpoint = if raw["ConfigurationEndpoint"].is_object() {
            &raw["ConfigurationEndpoint"]
        } else {
            &raw["NodeGroups"][0]["PrimaryEndpoint"]
        };
        let Some(address) = text(&endpoint["Address"]) else {
            continue;
        };
        let transit_encryption = raw["TransitEncryptionEnabled"].as_bool().unwrap_or(false);
        let engine = text(&raw["Engine"]).unwrap_or_else(|| "redis".to_string());
        let (supported_engine, unsupported_reason) = map_engine(&engine, transit_encryption);
        out.push(AwsDatabase {
            identifier,
            service: "ElastiCache".to_string(),
            engine_version: text(&raw["CacheNodeType"]),
            port: endpoint["Port"].as_u64().unwrap_or(6379) as u16,
            username: String::new(),
            initial_database: None,
            status: text(&raw["Status"]).unwrap_or_else(|| "unknown".to_string()),
            engine,
            address,
            supported_engine,
            unsupported_reason,
        });
    }
    Ok(out)
}

/// Lists the managed databases visible to `profile` in `region`.
///
/// Each service is queried independently and a failure of one is not fatal: a
/// role with RDS access but no ElastiCache permission is entirely ordinary,
/// and returning nothing at all because one of four calls was denied would be
/// worse than returning the three that worked. Only a total failure is
/// reported, and then with the first refusal — which is the one that explains
/// it (expired session, wrong profile).
pub async fn discover(profile: &str, region: &str) -> Result<Vec<AwsDatabase>, AwsCliError> {
    let args = |service: &'static str, call: &'static str| {
        vec![
            service.to_string(),
            call.to_string(),
            "--profile".to_string(),
            profile.to_string(),
            "--region".to_string(),
            region.to_string(),
            "--output".to_string(),
            "json".to_string(),
        ]
    };
    let call = |service: &'static str, name: &'static str| async move {
        let owned = args(service, name);
        let borrowed: Vec<&str> = owned.iter().map(String::as_str).collect();
        run_aws(&borrowed).await
    };

    let mut found = Vec::new();
    let mut first_error = None;
    let mut collect = |result: Result<Vec<AwsDatabase>, AwsCliError>| match result {
        Ok(mut items) => found.append(&mut items),
        Err(e) => {
            if first_error.is_none() {
                first_error = Some(e);
            }
        }
    };

    collect(match call("rds", "describe-db-clusters").await {
        Ok(json) => parse_clusters(&json, "Aurora"),
        Err(e) => Err(e),
    });
    collect(match call("rds", "describe-db-instances").await {
        Ok(json) => parse_instances(&json),
        Err(e) => Err(e),
    });
    collect(match call("docdb", "describe-db-clusters").await {
        Ok(json) => parse_clusters(&json, "DocumentDB"),
        Err(e) => Err(e),
    });
    collect(match call("elasticache", "describe-replication-groups").await {
        Ok(json) => parse_replication_groups(&json),
        Err(e) => Err(e),
    });

    if let (true, Some(error)) = (found.is_empty(), first_error) {
        return Err(error);
    }
    // `aws rds describe-db-clusters` also returns DocumentDB clusters in some
    // API versions, so the same cluster can arrive twice under two service
    // names. Keyed on the endpoint, which is what actually identifies it.
    found.sort_by(|a, b| a.identifier.to_lowercase().cmp(&b.identifier.to_lowercase()));
    found.dedup_by(|a, b| a.address == b.address && a.port == b.port);
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLUSTERS: &str = r#"{
      "DBClusters": [
        {
          "DBClusterIdentifier": "analytics-pg",
          "Engine": "aurora-postgresql",
          "EngineVersion": "15.4",
          "Status": "available",
          "MasterUsername": "postgres",
          "DatabaseName": "analytics",
          "Endpoint": "analytics-pg.cluster-abc.eu-west-3.rds.amazonaws.com",
          "ReaderEndpoint": "analytics-pg.cluster-ro-abc.eu-west-3.rds.amazonaws.com",
          "Port": 5432
        }
      ]
    }"#;

    const INSTANCES: &str = r#"{
      "DBInstances": [
        {
          "DBInstanceIdentifier": "prod-mysql",
          "Engine": "mysql",
          "EngineVersion": "8.0.35",
          "DBInstanceStatus": "available",
          "MasterUsername": "admin",
          "DBName": "appdb",
          "Endpoint": { "Address": "prod-mysql.abc.eu-west-3.rds.amazonaws.com", "Port": 3306 }
        },
        {
          "DBInstanceIdentifier": "analytics-pg-instance-1",
          "DBClusterIdentifier": "analytics-pg",
          "Engine": "aurora-postgresql",
          "DBInstanceStatus": "available",
          "Endpoint": { "Address": "analytics-pg-instance-1.abc.eu-west-3.rds.amazonaws.com", "Port": 5432 }
        },
        {
          "DBInstanceIdentifier": "legacy-oracle",
          "Engine": "oracle-se2",
          "DBInstanceStatus": "available",
          "MasterUsername": "system",
          "Endpoint": { "Address": "legacy-oracle.abc.eu-west-3.rds.amazonaws.com", "Port": 1521 }
        }
      ]
    }"#;

    #[test]
    fn reads_an_aurora_cluster_with_its_writer_endpoint() {
        let found = parse_clusters(CLUSTERS, "Aurora").unwrap();
        assert_eq!(found.len(), 1);
        let cluster = &found[0];
        assert_eq!(cluster.address, "analytics-pg.cluster-abc.eu-west-3.rds.amazonaws.com");
        assert_eq!(cluster.port, 5432);
        assert_eq!(cluster.supported_engine, Some(SqlEngine::Postgres));
        assert_eq!(cluster.initial_database.as_deref(), Some("analytics"));
        assert_eq!(cluster.username, "postgres");
    }

    /// The member instances of a cluster must not be offered alongside it: an
    /// instance endpoint points at one machine and silently stops being the
    /// writer after a failover, which is precisely the mistake this avoids.
    #[test]
    fn skips_instances_that_belong_to_a_cluster() {
        let found = parse_instances(INSTANCES).unwrap();
        let ids: Vec<_> = found.iter().map(|d| d.identifier.as_str()).collect();
        assert!(!ids.contains(&"analytics-pg-instance-1"), "obtenu : {ids:?}");
        assert_eq!(ids, vec!["prod-mysql", "legacy-oracle"]);
    }

    /// Listed, with the reason — not hidden. "Where is my database" is a dead
    /// end; "there it is, and here is why it can't be used" is not.
    #[test]
    fn an_unsupported_engine_is_listed_with_its_reason() {
        let found = parse_instances(INSTANCES).unwrap();
        let oracle = found.iter().find(|d| d.identifier == "legacy-oracle").unwrap();
        assert_eq!(oracle.supported_engine, None);
        assert!(oracle.unsupported_reason.is_some());
        assert!(!oracle.importable());
    }

    #[test]
    fn a_standalone_instance_carries_its_credentials_and_database() {
        let found = parse_instances(INSTANCES).unwrap();
        let mysql = found.iter().find(|d| d.identifier == "prod-mysql").unwrap();
        assert_eq!(mysql.supported_engine, Some(SqlEngine::Mysql));
        assert_eq!(mysql.username, "admin");
        assert_eq!(mysql.initial_database.as_deref(), Some("appdb"));
        assert_eq!(mysql.port, 3306);
        assert!(mysql.importable());
    }

    #[test]
    fn reads_an_elasticache_group_primary_endpoint() {
        let json = r#"{"ReplicationGroups":[{
            "ReplicationGroupId": "sessions",
            "Status": "available",
            "TransitEncryptionEnabled": false,
            "NodeGroups": [{ "PrimaryEndpoint": { "Address": "sessions.abc.ng.0001.euw3.cache.amazonaws.com", "Port": 6379 } }]
        }]}"#;
        let found = parse_replication_groups(json).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].address, "sessions.abc.ng.0001.euw3.cache.amazonaws.com");
        assert_eq!(found[0].port, 6379);
        assert_eq!(found[0].supported_engine, Some(SqlEngine::Redis));
    }

    /// Cluster mode on has no per-node-group primary — the single
    /// configuration endpoint is what clients dial.
    #[test]
    fn prefers_the_configuration_endpoint_when_cluster_mode_is_on() {
        let json = r#"{"ReplicationGroups":[{
            "ReplicationGroupId": "sharded",
            "Status": "available",
            "ConfigurationEndpoint": { "Address": "sharded.abc.clustercfg.euw3.cache.amazonaws.com", "Port": 6379 },
            "NodeGroups": [{ "PrimaryEndpoint": { "Address": "ignored.example", "Port": 1 } }]
        }]}"#;
        let found = parse_replication_groups(json).unwrap();
        assert_eq!(found[0].address, "sharded.abc.clustercfg.euw3.cache.amazonaws.com");
    }

    /// The app's Redis client dials `redis://` and nothing else. Importing an
    /// encrypted cluster would produce a connection that cannot succeed.
    #[test]
    fn an_encrypted_elasticache_group_is_refused_with_the_reason() {
        let json = r#"{"ReplicationGroups":[{
            "ReplicationGroupId": "secure",
            "Status": "available",
            "TransitEncryptionEnabled": true,
            "NodeGroups": [{ "PrimaryEndpoint": { "Address": "secure.example", "Port": 6379 } }]
        }]}"#;
        let found = parse_replication_groups(json).unwrap();
        assert_eq!(found[0].supported_engine, None);
        assert!(found[0].unsupported_reason.as_deref().unwrap().contains("TLS"));
    }

    /// DocumentDB is reachable only over TLS signed by the Amazon RDS CA,
    /// which isn't in any system trust store and isn't shipped here.
    #[test]
    fn documentdb_is_refused_with_the_certificate_reason() {
        let (engine, reason) = map_engine("docdb", false);
        assert_eq!(engine, None);
        assert!(reason.unwrap().contains("Amazon RDS"));
    }

    #[test]
    fn maps_the_aws_engine_names_onto_app_engines() {
        assert_eq!(map_engine("aurora-mysql", false).0, Some(SqlEngine::Mysql));
        assert_eq!(map_engine("mariadb", false).0, Some(SqlEngine::Mysql));
        assert_eq!(map_engine("postgres", false).0, Some(SqlEngine::Postgres));
        assert_eq!(map_engine("valkey", false).0, Some(SqlEngine::Redis));
        assert_eq!(map_engine("sqlserver-ex", false).0, None);
    }

    /// A database still being created can't be connected to; it is listed so
    /// its arrival is visible, but not offered.
    #[test]
    fn a_database_that_is_not_available_is_not_importable() {
        let json = r#"{"DBInstances":[{
            "DBInstanceIdentifier": "coming-up",
            "Engine": "mysql",
            "DBInstanceStatus": "creating",
            "Endpoint": { "Address": "coming-up.example", "Port": 3306 }
        }]}"#;
        let found = parse_instances(json).unwrap();
        assert_eq!(found[0].supported_engine, Some(SqlEngine::Mysql));
        assert!(!found[0].importable(), "un moteur géré mais pas encore prêt reste non importable");
    }

    #[test]
    fn an_empty_account_is_an_empty_list() {
        assert!(parse_clusters(r#"{"DBClusters":[]}"#, "Aurora").unwrap().is_empty());
        assert!(parse_instances(r#"{"DBInstances":[]}"#).unwrap().is_empty());
        assert!(parse_replication_groups(r#"{"ReplicationGroups":[]}"#).unwrap().is_empty());
    }

    /// The frontend reads these off the JSON — a field that doesn't serialise
    /// under the expected name is invisible with no error anywhere.
    #[test]
    fn the_json_carries_the_camel_cased_fields_the_frontend_reads() {
        let found = parse_instances(INSTANCES).unwrap();
        let json = serde_json::to_value(&found[0]).unwrap();
        assert_eq!(json["identifier"], "prod-mysql");
        assert_eq!(json["supportedEngine"], "mysql");
        assert_eq!(json["initialDatabase"], "appdb");
        assert_eq!(json["engineVersion"], "8.0.35");
    }
}
