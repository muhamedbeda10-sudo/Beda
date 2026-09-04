import { describe, expect, it, beforeAll } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import {
  columnIndex,
  dateShapeOfFormat,
  formatNumber,
  isLegacyExcelFile,
  isZipFile,
  readWorkbook,
  serialToIso,
  WorkbookReadError,
} from './xlsx'

// The reader uses the browser's DOMParser; vitest runs in node, so a
// spec-compliant one is installed for the duration of these tests.
beforeAll(() => {
  ;(globalThis as { DOMParser?: unknown }).DOMParser = XmlDomParser
})

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

function workbookBytes(parts: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, xml] of Object.entries(parts)) entries[path] = strToU8(xml)
  return zipSync(entries)
}

/** A workbook the way Excel writes it: shared strings, styles, two sheets. */
function excelLikeWorkbook(): Uint8Array {
  return workbookBytes({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="${PKG_REL_NS}">
        <Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">
        <workbookPr/>
        <sheets>
          <sheet name="Coils" sheetId="1" r:id="rId1"/>
          <sheet name="Notes" sheetId="2" r:id="rId2"/>
        </sheets>
      </workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="${PKG_REL_NS}">
        <Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rId2" Type="${REL_NS}/worksheet" Target="/xl/worksheets/sheet2.xml"/>
        <Relationship Id="rId3" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>
        <Relationship Id="rId4" Type="${REL_NS}/styles" Target="styles.xml"/>
      </Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="${MAIN_NS}" count="6" uniqueCount="6">
        <si><t>Coil number</t></si>
        <si><t>Grade</t></si>
        <si><t>Thickness</t></si>
        <si><t>Received</t></si>
        <si><r><rPr><b/></rPr><t>S355</t></r><r><t xml:space="preserve"> JR</t></r><rPh sb="0" eb="4"><t>reading</t></rPh></si>
        <si><t>C10021</t></si>
      </sst>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <styleSheet xmlns="${MAIN_NS}">
        <numFmts count="2">
          <numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
          <numFmt numFmtId="165" formatCode="[$€-1] #,##0.00"/>
        </numFmts>
        <cellXfs count="5">
          <xf numFmtId="0"/>
          <xf numFmtId="14" applyNumberFormat="1"/>
          <xf numFmtId="164" applyNumberFormat="1"/>
          <xf numFmtId="22" applyNumberFormat="1"/>
          <xf numFmtId="165" applyNumberFormat="1"/>
        </cellXfs>
      </styleSheet>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="${MAIN_NS}">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
            <c r="C1" t="s"><v>2</v></c>
            <c r="D1" t="s"><v>3</v></c>
            <c r="E1" t="inlineStr"><is><t>Width</t></is></c>
          </row>
          <row r="2">
            <c r="A2" t="s"><v>5</v></c>
            <c r="B2" t="s"><v>4</v></c>
            <c r="C2"><v>2.5</v></c>
            <c r="D2" s="1"><v>46269</v></c>
            <c r="E2"><f>1000+250</f><v>1250</v></c>
          </row>
          <row r="3">
            <c r="A3" t="str"><v>C10022</v></c>
            <c r="B3" t="e"><v>#N/A</v></c>
            <c r="C3"><v>0.30000000000000004</v></c>
            <c r="D3" s="2"><v>60</v></c>
            <c r="E3" t="b"><v>1</v></c>
          </row>
          <row r="4"/>
          <row r="5">
            <c r="A5"><v>10023</v></c>
            <c r="D5" s="3"><v>46269.3125</v></c>
            <c r="E5" s="4"><v>19.99</v></c>
          </row>
        </sheetData>
      </worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?>
      <x:worksheet xmlns:x="${MAIN_NS}">
        <x:sheetData>
          <x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>b</x:t></x:is></x:c></x:row>
          <x:row><x:c><x:v>1</x:v></x:c><x:c><x:v>2</x:v></x:c></x:row>
        </x:sheetData>
      </x:worksheet>`,
  })
}

describe('file sniffing', () => {
  it('recognises a zip container and the old binary .xls', () => {
    expect(isZipFile(excelLikeWorkbook())).toBe(true)
    expect(isZipFile(strToU8('coilNumber,grade\nC1,S355'))).toBe(false)
    expect(isLegacyExcelFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toBe(true)
    expect(isLegacyExcelFile(excelLikeWorkbook())).toBe(false)
  })
})

describe('readWorkbook', () => {
  it('reads every sheet as a string grid, in workbook order', () => {
    const wb = readWorkbook(excelLikeWorkbook())
    expect(wb.sheets.map((s) => s.name)).toEqual(['Coils', 'Notes'])
    expect(wb.sheets[0].rows).toEqual([
      ['Coil number', 'Grade', 'Thickness', 'Received', 'Width'],
      ['C10021', 'S355 JR', '2.5', '2026-09-04', '1250'],
      // Serial 60 is Excel's phantom 29 Feb 1900; the nearest real day is used.
      ['C10022', '', '0.3', '1900-03-01', 'TRUE'],
      ['10023', '', '', '2026-09-04 07:30:00', '19.99'],
    ])
  })

  it('reads prefixed (x:) markup and cells without references', () => {
    const wb = readWorkbook(excelLikeWorkbook())
    expect(wb.sheets[1].rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('honours the 1904 date system', () => {
    const bytes = workbookBytes({
      'xl/workbook.xml': `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/styles.xml': `<styleSheet xmlns="${MAIN_NS}"><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${MAIN_NS}"><sheetData><row r="1"><c r="A1" s="0"><v>0</v></c></row></sheetData></worksheet>`,
    })
    expect(readWorkbook(bytes).sheets[0].rows).toEqual([['1904-01-01']])
  })

  it('refuses files that are not workbooks with a message the user can act on', () => {
    expect(() => readWorkbook(strToU8('coilNumber,grade\nC1,S355'))).toThrow(WorkbookReadError)
    expect(() => readWorkbook(workbookBytes({ 'word/document.xml': '<d/>' }))).toThrow(/not an Excel workbook/)
    expect(() =>
      readWorkbook(workbookBytes({ 'xl/workbook.xml': `<workbook xmlns="${MAIN_NS}"><sheets/></workbook>` })),
    ).toThrow(/no worksheets/)
  })
})

describe('value conversion', () => {
  it('renders numbers the way Excel displays them', () => {
    expect(formatNumber('0.30000000000000004')).toBe('0.3')
    expect(formatNumber('1.1000000000000001')).toBe('1.1')
    expect(formatNumber('1250')).toBe('1250')
    expect(formatNumber('-2.5E-3')).toBe('-0.0025')
    expect(formatNumber('abc')).toBe('abc')
  })

  it('converts day serials in both date systems', () => {
    expect(serialToIso(1, 'date', false)).toBe('1900-01-01')
    expect(serialToIso(59, 'date', false)).toBe('1900-02-28')
    expect(serialToIso(61, 'date', false)).toBe('1900-03-01')
    expect(serialToIso(46269, 'date', false)).toBe('2026-09-04')
    expect(serialToIso(46269.5, 'datetime', false)).toBe('2026-09-04 12:00:00')
    expect(serialToIso(0.75, 'time', false)).toBe('18:00:00')
    expect(serialToIso(1, 'date', true)).toBe('1904-01-02')
  })

  it('classifies number-format codes', () => {
    expect(dateShapeOfFormat('dd/mm/yyyy')).toBe('date')
    expect(dateShapeOfFormat('yyyy-mm-dd hh:mm')).toBe('datetime')
    expect(dateShapeOfFormat('h:mm AM/PM')).toBe('time')
    expect(dateShapeOfFormat('[h]:mm:ss')).toBe('time')
    expect(dateShapeOfFormat('mmm-yy')).toBe('date')
    expect(dateShapeOfFormat('[$€-1] #,##0.00')).toBeUndefined()
    expect(dateShapeOfFormat('0.00 "mm"')).toBeUndefined()
    expect(dateShapeOfFormat('[Red]0.0;[Blue]-0.0')).toBeUndefined()
    expect(dateShapeOfFormat('General')).toBeUndefined()
  })

  it('maps column letters to indexes', () => {
    expect(columnIndex('A1')).toBe(0)
    expect(columnIndex('Z10')).toBe(25)
    expect(columnIndex('AA1')).toBe(26)
    expect(columnIndex('AZ3')).toBe(51)
    expect(columnIndex('12')).toBeUndefined()
  })
})
