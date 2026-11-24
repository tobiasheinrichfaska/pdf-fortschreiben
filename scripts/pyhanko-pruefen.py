# pyHanko validation of every document time stamp + pikepdf open. Run: .tmp/venv/bin/python scripts/pyhanko-pruefen.py
import sys
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_timestamp
from pyhanko.sign.general import load_cert_from_pemder
from pyhanko_certvalidator import ValidationContext

import sys
root = load_cert_from_pemder('.tmp/pki/root.crt')
for path in ['.tmp/monat.pdf', '.tmp/kontrolle.pdf']:
  print('=====', path)
  with open(path, 'rb') as fh:
      r = PdfFileReader(fh)
      sigs = r.embedded_regular_signatures + r.embedded_timestamp_signatures
      print('regular:', len(r.embedded_regular_signatures), 'timestamps:', len(r.embedded_timestamp_signatures))
      for s in r.embedded_timestamp_signatures:
          vc = ValidationContext(trust_roots=[root], allow_fetching=False)
          try:
              st = validate_pdf_timestamp(s, validation_context=vc)
              print(s.field_name, 'intact=%s valid=%s trusted=%s' % (st.intact, st.valid, st.trusted), 'time=', st.timestamp)
              print('  coverage:', st.coverage, ' modification_level:', st.modification_level)
              print('  summary:', st.summary())
          except Exception as e:
              print(s.field_name, 'ERROR', type(e).__name__, e)
import pikepdf
for path in ['.tmp/monat.pdf', '.tmp/kontrolle.pdf']:
  p = pikepdf.open(path)
  print('pikepdf pages', len(p.pages), 'attachments', list(p.attachments.keys()))
  print('pikepdf check_pdf_syntax (problems):', p.check_pdf_syntax())
