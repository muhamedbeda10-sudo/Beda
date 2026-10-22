/** Resolve the three requested people against their actual registered names,
 * including Arabic and common English spellings. Display and save the name
 * on the account itself; never create another account or a separate roster. */
export function isConcessionGrantor(name: string): boolean {
  const value = name.normalize('NFKD').replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').toLowerCase()
  const mahmoud = /محمود|mahmo(?:u|o)?d/.test(value) && /جعفر|(?:g|j)[aeiouy]*f+[aeiouy]*r/.test(value)
  const mohamed = /محمد|(?:mo|mu)ham[maeou]*d/.test(value) && /مجدي|magd[yi]/.test(value)
  const taher = /طاهر|taher|tahir/.test(value)
  return mahmoud || mohamed || taher
}
