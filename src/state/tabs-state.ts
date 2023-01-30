import { computed, reactive } from 'vue'

import { v4 as uuid } from 'uuid'
import {
  ExecutionProfile,
  AssemblyExecutionProfile,
  ElfExecutionProfile,
  disassembleElf
} from '../utils/mips'
import { SelectionIndex, SelectionRange } from '../utils/editor'

export type CursorState = SelectionIndex & {
  highlight: SelectionIndex | null
}

export function selectionRange(cursor: CursorState): SelectionRange | null {
  if (!cursor.highlight) {
    return null
  }

  // Took out technical debt here and the methods in EditorBody for selection.
  const highlightBeforeLine = cursor.highlight.line < cursor.line
  const highlightBeforeIndex = cursor.highlight.line === cursor.line
    && cursor.highlight.index < cursor.index

  if (highlightBeforeLine || highlightBeforeIndex) {
    // assert cursor.highlight.line <= cursor.line
    return {
      startLine: cursor.highlight.line,
      startIndex: cursor.highlight.index,
      endLine: cursor.line,
      endIndex: cursor.index
    }
  } else {
    // assert cursor.highlight.line >= cursor.line
    return {
      startLine: cursor.line,
      startIndex: cursor.index,
      endLine: cursor.highlight.line,
      endIndex: cursor.highlight.index
    }
  }
}

export interface EditorTab {
  uuid: string,
  title: string,
  lines: string[],
  cursor: CursorState,
  breakpoints: number[],
  path: string | null,
  marked: boolean, // needs saving
  profile: ExecutionProfile | null
}

export function collectLines(lines: string[]): string {
  return lines.join('\n')
}

export interface TabsState {
  tabs: EditorTab[]
  selected: string | null
}

export const editor = reactive({
  tabs: [],
  selected: null,
  execution: null,
  debug: null
} as TabsState)

export function tab(): EditorTab | null {
  if (editor.selected) {
    return editor.tabs.find(tab => tab.uuid === editor.selected) ?? null
  }

  return null
}

export const tabBody = computed(() => tab()?.lines ?? ['Nothing yet.'])

export function closeTab(uuid: string) {
  const index = editor.tabs.findIndex(tab => tab.uuid === uuid)

  editor.tabs = editor.tabs.filter(tab => tab.uuid !== uuid)

  if (editor.selected === uuid) {
    if (editor.tabs.length < 0) {
      editor.selected = null

      return
    }

    const point = Math.min(Math.max(index - 1, 0), editor.tabs.length)

    editor.selected = editor.tabs[point].uuid
  }
}

function defaultAssemblyProfile(): AssemblyExecutionProfile  {
  return { kind: 'asm' }
}

export function createTab(
  named: string,
  content: string[],
  path: string | null = null,
  profile: ExecutionProfile | null = defaultAssemblyProfile()
) {
  const id = uuid()

  editor.tabs.push({
    uuid: id,
    title: named,
    lines: content,
    breakpoints: [],
    cursor: {
      line: 0,
      index: 0,
      highlight: null
    },
    path,
    marked: false,
    profile
  })

  editor.selected = id
}

export async function loadElf(named: string, elf: ArrayBuffer) {
  const value = await disassembleElf(named, elf)

  const lines = value.error ? [value.error] : value.lines
  const profile = {
    kind: 'elf', elf, breakpoints: value.breakpoints
  } as ElfExecutionProfile

  createTab(named, lines, null, profile)
}

if (!editor.tabs.length) {
  createTab('Untitled', [''])
}
