import org.springframework.boot.gradle.plugin.SpringBootPlugin

plugins {
    java
    id("org.springframework.boot") version "3.5.16"
}

group = "sample.relay"
version = "0.1.0"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(platform(SpringBootPlugin.BOM_COORDINATES))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    runtimeOnly("org.postgresql:postgresql:42.7.14")
    // JWS(HS256)·JWE(RSA-OAEP-256 + A256GCM). Mailo의 jose 6.2.18과의 상호 운용은 README의 검증 절을 본다.
    implementation("com.nimbusds:nimbus-jose-jwt") {
        version { strictly("10.10") }
    }

    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}
