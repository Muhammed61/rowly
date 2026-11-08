import { useMemo } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { sql, MySQL, PostgreSQL, SQLite, MSSQL, StandardSQL, type SQLNamespace } from '@codemirror/lang-sql'
import { keymap, EditorView } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { familyOf } from '@shared/dialects'
import type { DbType } from '@shared/types'
import { isDark, useStore } from '../store'

const dialectOf = (t: DbType) => {
  switch (t) {
    case 'mysql':
    case 'mariadb':
      return MySQL
    case 'postgres':
    case 'cockroach':
    case 'redshift':
      return PostgreSQL
    case 'sqlite':
      return SQLite
    case 'mssql':
      return MSSQL
    default:
      return StandardSQL
  }
}

const baseTheme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: 'var(--bg-elev)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-elev)', borderRight: '1px solid var(--border)', color: 'var(--text-3)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
  '.cm-content': { padding: '8px 0' },
  '.cm-tooltip-autocomplete': { borderRadius: '6px', overflow: 'hidden' }
})

export function SqlEditor(props: {
  value: string
  onChange?(v: string): void
  dbType: DbType
  schema?: SQLNamespace
  readOnly?: boolean
  editorRef?: React.Ref<ReactCodeMirrorRef>
  onRun?(mode: 'current' | 'all'): void
  height?: string
}) {
  const theme = useStore((s) => s.theme)
  const { onRun } = props
  const extensions = useMemo(() => {
    const family = familyOf(props.dbType)
    const lang =
      family === 'mongo'
        ? [javascript()]
        : family === 'redis'
          ? []
          : [sql({ dialect: dialectOf(props.dbType), schema: props.schema, upperCaseKeywords: true })]
    const ext: Extension[] = [...lang, baseTheme, EditorView.lineWrapping]
    if (onRun) {
      ext.push(
        Prec.highest(
          keymap.of([
            { key: 'Mod-Enter', run: () => (onRun('current'), true) },
            { key: 'Mod-Shift-Enter', run: () => (onRun('all'), true) },
            { key: 'F5', run: () => (onRun('all'), true) }
          ])
        )
      )
    }
    return ext
  }, [props.dbType, props.schema, onRun])

  return (
    <CodeMirror
      ref={props.editorRef}
      value={props.value}
      onChange={props.onChange}
      extensions={extensions}
      theme={isDark(theme) ? 'dark' : 'light'}
      readOnly={props.readOnly}
      editable={!props.readOnly}
      height={props.height}
      basicSetup={{ foldGutter: false, highlightActiveLine: !props.readOnly, autocompletion: !props.readOnly }}
    />
  )
}
