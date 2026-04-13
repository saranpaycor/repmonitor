'use strict';

const express = require('express');
const sql = require('mssql');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Allow only valid SQL Server name characters (letters, digits, dots, hyphens, underscores, backslash for instance)
const VALID_SERVER_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-_\\]*$/;

app.post('/api/connect', async (req, res) => {
    const { server, port, authType, domain, username, password } = req.body;

    if (!server || typeof server !== 'string') {
        return res.status(400).json({ error: 'Server name is required.' });
    }

    const serverInput = server.trim();
    if (!VALID_SERVER_RE.test(serverInput)) {
        return res.status(400).json({ error: 'Invalid server name. Use format: servername or servername\\instance' });
    }

    const validAuthTypes = ['sql', 'windows', 'ntlm'];
    if (!validAuthTypes.includes(authType)) {
        return res.status(400).json({ error: 'Invalid authentication type.' });
    }

    const serverPort = port ? parseInt(port, 10) : 0;
    if (port && (isNaN(serverPort) || serverPort < 1 || serverPort > 65535)) {
        return res.status(400).json({ error: 'Invalid port number.' });
    }

    // Parse server\instance
    const backslashIdx = serverInput.indexOf('\\');
    const serverHost = backslashIdx > -1 ? serverInput.substring(0, backslashIdx) : serverInput;
    const instanceName = backslashIdx > -1 ? serverInput.substring(backslashIdx + 1) : undefined;

    const config = {
        server: serverHost,
        options: {
            encrypt: false,
            trustServerCertificate: true,
            enableArithAbort: true,
            connectTimeout: 15000,
            requestTimeout: 30000
        }
    };

    if (instanceName) {
        config.options.instanceName = instanceName;
    } else {
        config.port = serverPort || 1433;
    }

    if (authType === 'windows') {
        // Windows Integrated Auth — uses current process identity
        config.options.trustedConnection = true;
    } else if (authType === 'ntlm') {
        config.authentication = {
            type: 'ntlm',
            options: {
                domain: (domain || '').trim(),
                userName: (username || '').trim(),
                password: password || ''
            }
        };
    } else {
        // SQL Server auth
        if (!username || !username.trim()) {
            return res.status(400).json({ error: 'Username is required for SQL Server authentication.' });
        }
        config.user = username.trim();
        config.password = password || '';
    }

    let pool;
    try {
        pool = await new sql.ConnectionPool(config).connect();
        const data = await queryReplicationInfo(pool);
        res.json({ success: true, data });
    } catch (err) {
        // Sanitize error message — never expose password-related detail
        const safeMsg = err.message.replace(/password[^\s,]*/gi, '***');
        res.status(500).json({ error: safeMsg });
    } finally {
        if (pool) pool.close().catch(() => {});
    }
});

// ─── /api/agents — dedicated endpoint for distribution / log reader buttons ──

app.post('/api/agents', async (req, res) => {
    const { type, server, port, authType, domain, username, password } = req.body;

    if (!['distribution', 'logreader'].includes(type)) {
        return res.status(400).json({ error: 'Invalid agent type.' });
    }
    if (!server || typeof server !== 'string') {
        return res.status(400).json({ error: 'Server name is required.' });
    }

    const serverInput = server.trim();
    if (!VALID_SERVER_RE.test(serverInput)) {
        return res.status(400).json({ error: 'Invalid server name.' });
    }

    const validAuthTypes = ['sql', 'windows', 'ntlm'];
    if (!validAuthTypes.includes(authType)) {
        return res.status(400).json({ error: 'Invalid authentication type.' });
    }

    const serverPort = port ? parseInt(port, 10) : 0;
    if (port && (isNaN(serverPort) || serverPort < 1 || serverPort > 65535)) {
        return res.status(400).json({ error: 'Invalid port number.' });
    }

    const backslashIdx = serverInput.indexOf('\\');
    const serverHost   = backslashIdx > -1 ? serverInput.substring(0, backslashIdx) : serverInput;
    const instanceName = backslashIdx > -1 ? serverInput.substring(backslashIdx + 1) : undefined;

    const config = {
        server: serverHost,
        options: {
            encrypt: false, trustServerCertificate: true,
            enableArithAbort: true, connectTimeout: 15000, requestTimeout: 30000
        }
    };
    if (instanceName) { config.options.instanceName = instanceName; }
    else { config.port = serverPort || 1433; }

    if (authType === 'windows') {
        config.options.trustedConnection = true;
    } else if (authType === 'ntlm') {
        config.authentication = {
            type: 'ntlm',
            options: { domain: (domain || '').trim(), userName: (username || '').trim(), password: password || '' }
        };
    } else {
        if (!username || !username.trim()) {
            return res.status(400).json({ error: 'Username is required for SQL Server authentication.' });
        }
        config.user = username.trim();
        config.password = password || '';
    }

    let pool;
    try {
        pool = await new sql.ConnectionPool(config).connect();

        const dbChk = await pool.request().query(`SELECT COUNT(1) AS cnt FROM sys.databases WHERE name = 'distribution'`);
        if ((dbChk.recordset[0]?.cnt || 0) === 0) {
            return res.json({ success: true, agents: [], hasDistributionDb: false });
        }

        let agents = [];
        if (type === 'distribution') {
            const r = await pool.request().query(`
                SELECT
                    da.publisher_db                             AS PublisherDB,
                    da.publication                              AS Publication,
                    ISNULL(da.subscriber, '')                   AS Subscriber,
                    da.subscriber_db                            AS SubscriberDB,
                    da.name                                     AS AgentName,
                    CASE dh.runstatus
                        WHEN 1 THEN 'Started'  WHEN 2 THEN 'Succeeded'
                        WHEN 3 THEN 'Active'   WHEN 4 THEN 'Idle'
                        WHEN 5 THEN 'Retrying' WHEN 6 THEN 'Failed'
                        ELSE ISNULL(CAST(dh.runstatus AS VARCHAR(10)), 'Unknown')
                    END                                         AS Status,
                    dh.runstatus                                AS StatusCode,
                    LEFT(ISNULL(dh.comments, ''), 300)          AS LastAction,
                    CONVERT(VARCHAR(20), dh.time, 120)          AS LastSyncTime
                FROM distribution.dbo.MSdistribution_agents da
                OUTER APPLY (
                    SELECT TOP 1 runstatus, comments, time
                    FROM   distribution.dbo.MSdistribution_history h
                    WHERE  h.agent_id = da.id
                    ORDER BY h.timestamp DESC
                ) dh
                ORDER BY da.publisher_db, da.publication, da.subscriber_db
            `);
            agents = r.recordset || [];
        } else {
            const r = await pool.request().query(`
                SELECT
                    la.publisher_db                             AS PublisherDB,
                    la.publication                              AS Publication,
                    la.name                                     AS AgentName,
                    CASE lh.runstatus
                        WHEN 1 THEN 'Started'  WHEN 2 THEN 'Succeeded'
                        WHEN 3 THEN 'Active'   WHEN 4 THEN 'Idle'
                        WHEN 5 THEN 'Retrying' WHEN 6 THEN 'Failed'
                        ELSE ISNULL(CAST(lh.runstatus AS VARCHAR(10)), 'Unknown')
                    END                                         AS Status,
                    lh.runstatus                                AS StatusCode,
                    LEFT(ISNULL(lh.comments, ''), 300)          AS LastAction,
                    CONVERT(VARCHAR(20), lh.time, 120)          AS LastSyncTime
                FROM distribution.dbo.MSlogreader_agents la
                OUTER APPLY (
                    SELECT TOP 1 runstatus, comments, time
                    FROM   distribution.dbo.MSlogreader_history h
                    WHERE  h.agent_id = la.id
                    ORDER BY h.timestamp DESC
                ) lh
                ORDER BY la.publisher_db
            `);
            agents = r.recordset || [];
        }

        res.json({ success: true, agents, hasDistributionDb: true });
    } catch (err) {
        const safeMsg = err.message.replace(/password[^\s,]*/gi, '***');
        res.status(500).json({ error: safeMsg });
    } finally {
        if (pool) pool.close().catch(() => {});
    }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const AGENT_STATUS_CASE = (col) => `
    CASE ${col}
        WHEN 1 THEN 'Started'
        WHEN 2 THEN 'Succeeded'
        WHEN 3 THEN 'Active'
        WHEN 4 THEN 'Idle'
        WHEN 5 THEN 'Retrying'
        WHEN 6 THEN 'Failed'
        ELSE CAST(${col} AS VARCHAR(10))
    END`;

async function safeQuery(pool, label, queryFn, errors) {
    try {
        return await queryFn(pool);
    } catch (e) {
        errors.push({ section: label, error: e.message });
        return [];
    }
}

// ─── Main query function ─────────────────────────────────────────────────────

async function queryReplicationInfo(pool) {
    const result = {
        serverName: '',
        sqlVersion: '',
        runningJobs: [],
        allReplJobs: [],
        distributionAgents: [],
        logReaderAgents: [],
        snapshotAgents: [],
        mergeAgents: [],
        monitorData: [],
        hasDistributionDb: false,
        errors: []
    };

    // Server info
    try {
        const r = await pool.request().query(`SELECT @@SERVERNAME AS ServerName, @@VERSION AS SQLVersion`);
        result.serverName = r.recordset[0]?.ServerName || '';
        const ver = r.recordset[0]?.SQLVersion || '';
        const m = ver.match(/SQL Server (\d{4})/);
        result.sqlVersion = m ? `SQL Server ${m[1]}` : ver.substring(0, 60);
    } catch (e) { /* non-critical */ }

    // Currently running replication jobs
    result.runningJobs = await safeQuery(pool, 'Running Replication Jobs', async (p) => {
        const r = await p.request().query(`
            SELECT
                j.name                                              AS JobName,
                COALESCE(c.name, 'Unknown')                        AS Category,
                COALESCE(js.step_name, 'N/A')                      AS CurrentStep,
                CONVERT(VARCHAR(20), ja.start_execution_date, 120) AS StartTime
            FROM msdb.dbo.sysjobs j
            INNER JOIN msdb.dbo.sysjobactivity ja
                ON j.job_id = ja.job_id
                AND ja.session_id = (SELECT MAX(session_id) FROM msdb.dbo.syssessions)
            LEFT  JOIN msdb.dbo.syscategories c  ON j.category_id = c.category_id
            LEFT  JOIN msdb.dbo.sysjobsteps   js
                ON j.job_id = js.job_id AND ja.last_executed_step_id = js.step_id
            WHERE ja.start_execution_date IS NOT NULL
              AND ja.stop_execution_date  IS NULL
              AND (
                    c.name IN ('REPL-Distribution','REPL-LogReader','REPL-Merge','REPL-Snapshot','REPL-QueueReader')
                    OR j.name LIKE 'REPL-%'
                  )
            ORDER BY ja.start_execution_date DESC
        `);
        return r.recordset || [];
    }, result.errors);

    // All replication jobs with last run status
    result.allReplJobs = await safeQuery(pool, 'All Replication Jobs', async (p) => {
        const r = await p.request().query(`
            SELECT
                j.name                                              AS JobName,
                COALESCE(c.name, 'Unknown')                        AS Category,
                j.enabled                                          AS IsEnabled,
                CASE
                    WHEN ja.start_execution_date IS NOT NULL
                         AND ja.stop_execution_date IS NULL         THEN 'Running'
                    WHEN lh.run_status = 1                          THEN 'Succeeded'
                    WHEN lh.run_status = 0                          THEN 'Failed'
                    WHEN lh.run_status = 3                          THEN 'Cancelled'
                    WHEN lh.run_status IS NULL                      THEN 'Never Run'
                    ELSE 'Unknown'
                END                                                AS LastStatus,
                CONVERT(VARCHAR(20), ja.start_execution_date, 120) AS LastStartTime,
                CONVERT(VARCHAR(20), ja.stop_execution_date,  120) AS LastEndTime
            FROM msdb.dbo.sysjobs j
            LEFT  JOIN msdb.dbo.sysjobactivity ja
                ON j.job_id = ja.job_id
                AND ja.session_id = (SELECT MAX(session_id) FROM msdb.dbo.syssessions)
            LEFT  JOIN msdb.dbo.syscategories c ON j.category_id = c.category_id
            OUTER APPLY (
                SELECT TOP 1 run_status
                FROM   msdb.dbo.sysjobhistory h
                WHERE  h.job_id = j.job_id AND h.step_id = 0
                ORDER BY h.instance_id DESC
            ) lh
            WHERE (
                    c.name IN ('REPL-Distribution','REPL-LogReader','REPL-Merge','REPL-Snapshot','REPL-QueueReader')
                    OR j.name LIKE 'REPL-%'
                  )
            ORDER BY c.name, j.name
        `);
        return r.recordset || [];
    }, result.errors);

    // Check for distribution database
    try {
        const r = await pool.request().query(`SELECT COUNT(1) AS cnt FROM sys.databases WHERE name = 'distribution'`);
        result.hasDistributionDb = (r.recordset[0]?.cnt || 0) > 0;
    } catch (e) {
        result.errors.push({ section: 'Distribution DB Check', error: e.message });
    }

    if (!result.hasDistributionDb) return result;

    // Distribution Agents
    result.distributionAgents = await safeQuery(pool, 'Distribution Agents', async (p) => {
        const r = await p.request().query(`
            SELECT
                da.publisher_db                             AS PublisherDB,
                da.publication                              AS Publication,
                ISNULL(da.subscriber, '')                   AS Subscriber,
                da.subscriber_db                            AS SubscriberDB,
                da.name                                     AS AgentName,
                CASE dh.runstatus
                    WHEN 1 THEN 'Started'
                    WHEN 2 THEN 'Succeeded'
                    WHEN 3 THEN 'Active'
                    WHEN 4 THEN 'Idle'
                    WHEN 5 THEN 'Retrying'
                    WHEN 6 THEN 'Failed'
                    ELSE ISNULL(CAST(dh.runstatus AS VARCHAR(10)), 'Unknown')
                END                                         AS Status,
                dh.runstatus                                AS StatusCode,
                LEFT(ISNULL(dh.comments, ''), 300)          AS LastAction,
                CONVERT(VARCHAR(20), dh.time, 120)          AS LastSyncTime
            FROM distribution.dbo.MSdistribution_agents da
            OUTER APPLY (
                SELECT TOP 1 runstatus, comments, time
                FROM   distribution.dbo.MSdistribution_history h
                WHERE  h.agent_id = da.id
                ORDER BY h.timestamp DESC
            ) dh
            ORDER BY da.publisher_db, da.publication, da.subscriber_db
        `);
        return r.recordset || [];
    }, result.errors);

    // Log Reader Agents
    result.logReaderAgents = await safeQuery(pool, 'Log Reader Agents', async (p) => {
        const r = await p.request().query(`
            SELECT
                la.publisher_db                             AS PublisherDB,
                la.publication                              AS Publication,
                la.name                                     AS AgentName,
                CASE lh.runstatus
                    WHEN 1 THEN 'Started'
                    WHEN 2 THEN 'Succeeded'
                    WHEN 3 THEN 'Active'
                    WHEN 4 THEN 'Idle'
                    WHEN 5 THEN 'Retrying'
                    WHEN 6 THEN 'Failed'
                    ELSE ISNULL(CAST(lh.runstatus AS VARCHAR(10)), 'Unknown')
                END                                         AS Status,
                lh.runstatus                                AS StatusCode,
                LEFT(ISNULL(lh.comments, ''), 300)          AS LastAction,
                CONVERT(VARCHAR(20), lh.time, 120)          AS LastSyncTime
            FROM distribution.dbo.MSlogreader_agents la
            OUTER APPLY (
                SELECT TOP 1 runstatus, comments, time
                FROM   distribution.dbo.MSlogreader_history h
                WHERE  h.agent_id = la.id
                ORDER BY h.timestamp DESC
            ) lh
            ORDER BY la.publisher_db
        `);
        return r.recordset || [];
    }, result.errors);

    // Snapshot Agents
    result.snapshotAgents = await safeQuery(pool, 'Snapshot Agents', async (p) => {
        const r = await p.request().query(`
            SELECT
                sa.publisher_db                             AS PublisherDB,
                sa.publication                              AS Publication,
                sa.name                                     AS AgentName,
                CASE sh.runstatus
                    WHEN 1 THEN 'Started'
                    WHEN 2 THEN 'Succeeded'
                    WHEN 3 THEN 'Active'
                    WHEN 4 THEN 'Idle'
                    WHEN 5 THEN 'Retrying'
                    WHEN 6 THEN 'Failed'
                    ELSE ISNULL(CAST(sh.runstatus AS VARCHAR(10)), 'Unknown')
                END                                         AS Status,
                sh.runstatus                                AS StatusCode,
                LEFT(ISNULL(sh.comments, ''), 300)          AS LastAction
            FROM distribution.dbo.MSsnapshot_agents sa
            OUTER APPLY (
                SELECT TOP 1 runstatus, comments
                FROM   distribution.dbo.MSsnapshot_history h
                WHERE  h.agent_id = sa.id
                ORDER BY h.timestamp DESC
            ) sh
            ORDER BY sa.publisher_db
        `);
        return r.recordset || [];
    }, result.errors);

    // Merge Agents
    result.mergeAgents = await safeQuery(pool, 'Merge Agents', async (p) => {
        const r = await p.request().query(`
            SELECT
                ma.publisher_db                             AS PublisherDB,
                ma.publication                              AS Publication,
                ISNULL(ma.subscriber, '')                   AS Subscriber,
                ma.subscriber_db                            AS SubscriberDB,
                ma.name                                     AS AgentName,
                CASE mh.runstatus
                    WHEN 1 THEN 'Started'
                    WHEN 2 THEN 'Succeeded'
                    WHEN 3 THEN 'Active'
                    WHEN 4 THEN 'Idle'
                    WHEN 5 THEN 'Retrying'
                    WHEN 6 THEN 'Failed'
                    ELSE ISNULL(CAST(mh.runstatus AS VARCHAR(10)), 'Unknown')
                END                                         AS Status,
                mh.runstatus                                AS StatusCode,
                LEFT(ISNULL(mh.comments, ''), 300)          AS LastAction,
                CONVERT(VARCHAR(20), mh.time, 120)          AS LastSyncTime
            FROM distribution.dbo.MSmerge_agents ma
            OUTER APPLY (
                SELECT TOP 1 runstatus, comments, time
                FROM   distribution.dbo.MSmerge_history h
                WHERE  h.agent_id = ma.id
                ORDER BY h.timestamp DESC
            ) mh
            ORDER BY ma.publisher_db, ma.publication, ma.subscriber_db
        `);
        return r.recordset || [];
    }, result.errors);

    // Replication Monitor Data (available on SQL Server 2005+)
    try {
        const r = await pool.request().query(`
            SELECT
                publisher                                          AS Publisher,
                publisher_db                                       AS PublisherDB,
                publication                                        AS Publication,
                CASE publication_type
                    WHEN 0 THEN 'Transactional'
                    WHEN 1 THEN 'Snapshot'
                    WHEN 2 THEN 'Merge'
                    ELSE 'Unknown'
                END                                               AS PublicationType,
                ${AGENT_STATUS_CASE('status')}                    AS Status,
                status                                            AS StatusCode,
                worst_latency                                     AS WorstLatency,
                best_latency                                      AS BestLatency,
                avg_latency                                       AS AvgLatency,
                cur_latency                                       AS CurrentLatency,
                warning                                           AS Warning
            FROM distribution.dbo.MSreplication_monitordata
            ORDER BY publisher_db, publication
        `);
        result.monitorData = r.recordset || [];
    } catch (e) {
        // Table may not exist in older versions — silently skip
    }

    return result;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
    console.log(`\n  SQL Replication Monitor`);
    console.log(`  Open: http://localhost:${PORT}\n`);
});
