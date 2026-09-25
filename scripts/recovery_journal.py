"""Offline journal reconciliation. The archive must not be restored with the app.

PREPARED is written synchronously by DB triggers before the app can commit.
Unknown/in-progress transactions block recovery; they are never guessed to be
committed or aborted. Only committed entries are eligible for replay.
"""
import psycopg
from psycopg.types.json import Jsonb


def reconcile(app_url: str, archive_url: str) -> int:
    count = 0
    with psycopg.connect(app_url) as app, psycopg.connect(archive_url) as archive:
        source = app.execute('select id from private.journal_source').fetchone()[0]
        pending = archive.execute('''select e.id,e.transaction_id from journal.entries e
          where e.source_id=%s and not exists(select 1 from journal.finalizations f where f.id=e.id)
          order by e.ordinal''', (source,)).fetchall()
        for event_id, xid in pending:
            status = app.execute('select pg_xact_status(%s::xid8)', (xid,)).fetchone()[0]
            if status not in ('committed', 'aborted'):
                raise RuntimeError('UNRESOLVED_JOURNAL_TRANSACTION')
            exists = app.execute('select exists(select 1 from private.recovery_outbox where id=%s)',
                                 (event_id,)).fetchone()[0]
            if exists and status != 'committed':
                raise RuntimeError('JOURNAL_SOURCE_MISMATCH')
            archive.execute('insert into journal.finalizations(id,outcome) values(%s,%s) on conflict do nothing',
                            (event_id, 'COMMITTED' if exists else 'ABORTED'))
            count += 1
    return count


def committed_entries(archive_url: str, source_id):
    with psycopg.connect(archive_url) as archive:
        if archive.execute('''select exists(select 1 from journal.entries e where source_id=%s
          and not exists(select 1 from journal.finalizations f where f.id=e.id))''', (source_id,)).fetchone()[0]:
            raise RuntimeError('RECOVERY_BLOCKED_UNRESOLVED_JOURNAL')
        return archive.execute('''select e.id,e.organization_id,e.kind,e.payload from journal.entries e
          join journal.finalizations f on f.id=e.id where e.source_id=%s and f.outcome='COMMITTED'
          order by e.ordinal''', (source_id,)).fetchall()


def replay(app_url: str, archive_url: str) -> int:
    with psycopg.connect(app_url) as app:
        source = app.execute('select id from private.journal_source').fetchone()[0]
        entries = committed_entries(archive_url, source)
        app.execute('set local role fichaje_retention_operator')
        count = 0
        for event_id, org, kind, payload in entries:
            result = app.execute('select private.replay_recovery(%s,%s,%s,%s)',
                                 (event_id, org, kind, Jsonb(payload))).fetchone()[0]
            count += int(result)
        return count
