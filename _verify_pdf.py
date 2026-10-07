# -*- coding: utf-8 -*-
import os, re, sys, zlib

repo = "C:/Users/Alex/Desktop/Ticket hub"
pdf_path = os.path.join(repo, "payment-setup-guide.pdf")
html_path = os.path.join(repo, "docs", "payment-setup-guide.html")

print("PDF_EXISTS", os.path.exists(pdf_path))
if os.path.exists(pdf_path):
    data = open(pdf_path, "rb").read()
    print("PDF_SIZE", len(data))
    print("PDF_SIGNATURE", data[:8])
    print("PDF_TRAILER", data[-12:])
    # Count page objects
    pages = re.findall(rb"/Type\s*/Page[^s]", data)
    print("PDF_PAGE_OBJECTS", len(pages))
    # Try to decompress streams
    streams = re.findall(rb"stream\r?\n(.*?)endstream", data, re.S)
    decompressed = 0
    for s in streams:
        try:
            d = zlib.decompress(s)
            decompressed += 1
        except Exception:
            pass
    print("PDF_STREAMS_DECOMPRESSED", decompressed, "of", len(streams))
    # Look for text that might be embedded
    print("PDF_CONTAINS_DOMAIN", b"the" in data, b"guide" in data.lower())
