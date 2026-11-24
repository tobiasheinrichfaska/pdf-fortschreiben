set -e
# Test PKI (root, intermediate, time stamp signer) + openssl TSA config. Run from the library directory.
rm -rf .tmp/pki && mkdir -p .tmp/pki && cd .tmp/pki
cat > ext.cnf <<'X'
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
[tsa]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,timeStamping
subjectKeyIdentifier=hash
X
openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.crt -days 3650 -subj "/CN=PF Test Root/O=Test" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout inter.key -out inter.csr -subj "/CN=PF Test Intermediate/O=Test" 2>/dev/null
openssl x509 -req -in inter.csr -CA root.crt -CAkey root.key -CAcreateserial -out inter.crt -days 3650 -sha256 -extfile ext.cnf -extensions ca 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout tsa.key -out tsa.csr -subj "/CN=PF Test TSA/O=Test" 2>/dev/null
openssl x509 -req -in tsa.csr -CA inter.crt -CAkey inter.key -CAcreateserial -out tsa.crt -days 3650 -sha256 -extfile ext.cnf -extensions tsa 2>/dev/null
cat inter.crt root.crt > chain.pem
echo 1000 > tsaserial
cat > ts.cnf <<'X'
[tsa]
default_tsa=t
[t]
serial=tsaserial
crypto_device=builtin
signer_cert=tsa.crt
certs=chain.pem
signer_key=tsa.key
signer_digest=sha256
default_policy=1.2.3.4.1
digests=sha256
accuracy=secs:1
ordering=yes
tsa_name=yes
ess_cert_id_alg=sha256
X
echo "PKI written to .tmp/pki"
