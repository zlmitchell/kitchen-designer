// @ts-check
/**
 * Open a drawing of any kind the importer accepts.
 *
 * Three formats, one shape out: a list of pages, a list of paths per page, and
 * a scale if - and only if - the file actually knows one. Everything past this
 * point in `import/` is written against that and never asks what it opened.
 *
 * @typedef {object} Sheet
 * @property {'pdf'|'svg'|'dxf'} kind
 * @property {Array<{number: number, width: number, height: number}>} pages
 * Sizes in points, which is what a clip rectangle is measured in.
 * @property {?number} scale Real inches per point. Only a DXF knows: a PDF or
 * an SVG of a plan is a picture at a plotted scale and records nowhere which.
 * @property {(page: number) => Promise<import('./model.js').DrawnPath[]>} paths
 * @property {() => void} close
 */

import {openDxf} from './dxf.js';
import {openPdf} from './pdf.js';
import {openSvg} from './svg.js';

/**
 * Which of the three this is, by content first and by name second.
 *
 * Content first because the name is the caller's claim and the bytes are the
 * fact. A `.txt` full of DXF group codes is a DXF; a `.dxf` that is really a
 * PDF opens perfectly well as one, and refusing it on the extension would be
 * a refusal to read a file we can read.
 *
 * @param {Uint8Array} data
 * @param {string} [filename]
 * @returns {'pdf'|'svg'|'dxf'}
 */
export function kindOf(data, filename = '')
{
	const head = new TextDecoder('utf-8', {fatal: false})
		.decode(data.subarray(0, 4096))
		// A byte-order mark before an XML declaration is legal and common.
		// Written as an escape rather than as the character, which is invisible
		// in a source file and reads as a stray space.
		.replace(/^\uFEFF/, '');

	if (head.startsWith('%PDF-'))
	{
		return 'pdf';
	}
	if (head.startsWith('AutoCAD Binary DXF'))
	{
		// Refused with its name rather than misread: the binary form holds the
		// same drawing, but not as the group-code text every DXF reader in
		// reach expects.
		throw new Error(
			'That is a binary DXF. Save it as an ASCII DXF and try again.');
	}
	const lower = head.toLowerCase();
	if (lower.includes('<svg'))
	{
		return 'svg';
	}
	// An ASCII DXF opens with group code 0 and the word SECTION, each on its
	// own line, with the code padded to three columns by most writers and to
	// none by others.
	if (/^\s*0\s*[\r\n]+\s*SECTION/.test(head))
	{
		return 'dxf';
	}

	const suffix = filename.toLowerCase().split('.').pop() || '';
	if (suffix === 'pdf' || suffix === 'svg' || suffix === 'dxf')
	{
		return /** @type {'pdf'|'svg'|'dxf'} */ (suffix);
	}
	throw new Error(
		'That is not a PDF, an SVG or a DXF. Export the plan as one of those '
		+ 'and try again.');
}

/**
 * @param {Uint8Array} data
 * @param {string} [filename]
 * @param {object} [options] Parser overrides, for tests.
 * @returns {Promise<Sheet>}
 */
export async function openDrawing(data, filename = '', options = {})
{
	if (!data || !data.length)
	{
		throw new Error('That file is empty.');
	}
	const kind = kindOf(data, filename);
	if (kind === 'pdf')
	{
		return openPdf(data, options);
	}
	if (kind === 'dxf')
	{
		return openDxf(data, options);
	}
	return openSvg(data);
}
