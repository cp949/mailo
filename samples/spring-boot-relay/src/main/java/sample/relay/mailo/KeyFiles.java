package sample.relay.mailo;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.HexFormat;
import java.util.regex.Pattern;

/** 키 파일 읽기. 키 값은 로그나 오류 메시지에 넣지 않는다. */
final class KeyFiles {

    private static final Pattern HEX64 = Pattern.compile("^[0-9a-fA-F]{64}$");

    private KeyFiles() {}

    /** JWS HS256 비밀키. Mailo와 같은 형식이다: 32바이트의 base64 또는 64자 hex. */
    static byte[] readHmacSecret(Path file) {
        String text = readText(file).trim();
        byte[] key = HEX64.matcher(text).matches()
                ? HexFormat.of().parseHex(text)
                : Base64.getDecoder().decode(text);
        if (key.length != 32) {
            throw new IllegalStateException("JWS 비밀키는 32바이트여야 한다: " + file.getFileName());
        }
        return key;
    }

    /** Mailo JWE 공개키. PEM(SPKI)이고 RSA 3072비트여야 한다(ADR-0008 결정 1). */
    static RSAPublicKey readRsaPublicKey(Path file) {
        String pem = readText(file)
                .replace("-----BEGIN PUBLIC KEY-----", "")
                .replace("-----END PUBLIC KEY-----", "")
                .replaceAll("\\s", "");
        try {
            RSAPublicKey key = (RSAPublicKey) KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(pem)));
            if (key.getModulus().bitLength() != 3072) {
                throw new IllegalStateException("Mailo 공개키는 RSA 3072비트여야 한다");
            }
            return key;
        } catch (GeneralSecurityException | IllegalArgumentException e) {
            throw new IllegalStateException("공개키 PEM(SPKI)을 읽을 수 없다: " + file.getFileName(), e);
        }
    }

    private static String readText(Path file) {
        if (file == null) {
            throw new IllegalStateException("키 파일 경로가 설정되지 않았다");
        }
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("키 파일을 읽을 수 없다: " + file.getFileName(), e);
        }
    }
}
