import { listen } from '@tauri-apps/api/event'

import { collectLines, EditorTab } from './tabs'
import { build, pause, postBuildMessage, resume, step, stop } from './debug'
import {
  assemblyFilter, elfFilter,
  openElf,
  openInputFile,
  readInputFile,
  SelectedFile,
  selectSaveDestination,
  writeFile
} from './query/select-file'
import { consoleData, ConsoleType, openConsole, pushConsole } from '../state/console-data'
import { assembleWithBinary, assembleRegions, BinaryResult } from './mips'
import {
  closeTab,
  createTab,
  find,
  loadElf,
  showExportRegionsDialog,
  showSettings,
  suggestions,
  tab,
  tabsState
} from '../state/state'
import { appWindow } from '@tauri-apps/api/window'
import { watch } from 'vue'
import { MidiNote, playNote } from './midi'
import { splitLines } from './split-lines'
import { writeHexRegions } from './query/serialize-files'
import { writeBinaryFile } from '@tauri-apps/api/fs'

export enum PromptType {
  NeverPrompt,
  PromptWhenNeeded,
  ForcePrompt,
}

interface ConsoleEvent {
  uuid?: string
  message: string
}

export async function openTab(file: SelectedFile<string | Uint8Array>) {
  const { name, path, data } = file

  const existing = tabsState.tabs.find((tab) => tab.path === path)

  if (existing) {
    tabsState.selected = existing.uuid
    return
  }

  switch (typeof data) {
    case 'string':
      const split = splitLines(data)

      createTab(name, split.length ? split : [''], path)
      break

    default:
      await loadElf(name, data.buffer)
      break
  }
}

export async function saveTab(
  current: EditorTab,
  type: PromptType = PromptType.PromptWhenNeeded
): Promise<boolean> {
  if (type === PromptType.NeverPrompt && !current.path) {
    return true
  }

  if (type === PromptType.ForcePrompt || !current.path) {
    const result = await selectSaveDestination('Save File', assemblyFilter)

    if (!result) {
      return false
    }

    const { name, path } = result

    current.title = name
    current.path = path
  }

  const data = collectLines(current.lines)

  await writeFile(current.path, data)

  current.marked = false // Remove "needs saving" marker

  return true
}

export async function saveCurrentTab(
  prompt: PromptType = PromptType.PromptWhenNeeded
) {
  const current = tab()

  if (current) {
    await saveTab(current, prompt)
  }
}

interface PrintPayload {
  text: string
  error: boolean
}

export async function setupEvents() {
  await listen('print', (event) => {
    let payload = event.payload as PrintPayload

    pushConsole(
      payload.text,
      payload.error ? ConsoleType.Stderr : ConsoleType.Stdout
    )
  })

  await listen('new-tab', () => {
    createTab('Untitled', [''])
  })

  await listen('open-file', async () => {
    const result = await openInputFile()

    if (!result) {
      return
    }

    await openTab(result)
  })

  await listen('close-tab', () => {
    if (tabsState.selected) {
      closeTab(tabsState.selected)
    }
  })

  await listen('save', async () => {
    await saveCurrentTab()
  })

  await listen('save-as', async () => {
    await saveCurrentTab(PromptType.ForcePrompt)
  })

  await listen('build', async () => {
    await build()
  })

  await listen('run', async () => {
    await resume()
  })

  await listen('step', async () => {
    await step()
  })

  await listen('pause', async () => {
    await pause()
  })

  await listen('stop', async () => {
    await stop()
  })

  await listen('find', () => {
    find.state.show = true
    find.state.focus = true // send focus event
    suggestions.dismissSuggestions()
  })

  await listen('assemble', async () => {
    const current = tab()

    const result = await assembleWithBinary(collectLines(current?.lines ?? []), current?.path ?? null)

    if (result.binary) {
      const name = tab()?.title
      const extended = name ? `${name}.elf` : 'Untitled Elf'

      await loadElf(extended, result.binary)
    }

    consoleData.showConsole = true
    postBuildMessage(result.result)
  })

  await listen('export', async () => {
    const current = tab()

    if (!current) {
      return
    }

    let binary: Uint8Array | null = null
    let result: BinaryResult | null = null

    if (current.profile && current.profile.kind === 'elf') {
      binary = Uint8Array.from(window.atob(current.profile.elf), c => c.charCodeAt(0))
    } else {
      result = await assembleWithBinary(collectLines(current.lines), current.path)
      binary = result.binary
    }

    let destination: SelectedFile<undefined> | null = null

    if (binary !== null) {
      destination = await selectSaveDestination('Save File', elfFilter)

      if (!destination) {
        return
      }

      await writeBinaryFile(destination.path, binary)
    }

    consoleData.showConsole = true

    if (result !== null) {
      postBuildMessage(result.result)
    }

    if (destination !== null) {
      pushConsole(`ELF file written to ${destination.path}`, ConsoleType.Info)
    }
  })

  await listen('export-hex', async () => {
    showExportRegionsDialog.value = true
  })

  await listen('disassemble', async () => {
    const result = await openElf()

    if (!result) {
      return
    }

    const { name, data } = result

    await loadElf(name, data.buffer)
  })

  await listen('toggle-console', () => {
    consoleData.showConsole = !consoleData.showConsole
  })

  await listen('toggle-settings', (event) => {
    showSettings.value = !showSettings.value
  })

  await listen('play-midi', async (event) => {
    await playNote(event.payload as MidiNote)
  })

  let events = new Map<string, number>() // uuid to number
  watch(
    () => consoleData.console,
    () => (events = new Map())
  )

  await listen('post-console-event', (event) => {
    const payload = event.payload as ConsoleEvent

    const push = () => pushConsole(payload.message, ConsoleType.Info)

    if (payload.uuid) {
      const id = events.get(payload.uuid)

      if (id) {
        consoleData.console[id] = payload.message
      } else {
        events.set(payload.uuid, push())
      }
    } else {
      push()
    }
  })

  await appWindow.onFileDropEvent(async (event) => {
    if (event.payload.type === 'drop') {
      for (const item of event.payload.paths) {
        const file = await readInputFile(item)

        if (!file) {
          continue
        }

        await openTab(file)
      }
    }
  })

  await appWindow.onCloseRequested(async (event) => {
    const ids = tabsState.tabs.map((x) => x.uuid)

    for (const id of ids) {
      if (!closeTab(id)) {
        event.preventDefault()
      }
    }
  })
}
