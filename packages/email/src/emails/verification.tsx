import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Tailwind,
  Text,
  pixelBasedPreset,
} from "react-email";

export interface VerificationEmailProps {
  readonly name: string;
  readonly url: string;
}

export function VerificationEmail({ name, url }: VerificationEmailProps) {
  return (
    <Html lang="en">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head>
          <meta name="color-scheme" content="dark" />
          <meta name="supported-color-schemes" content="dark" />
        </Head>
        <Body className="bg-[#111113] font-sans text-[#edeef0]">
          <Preview>Verify your Metamorph email address</Preview>
          <Container className="mx-auto my-8 max-w-xl rounded-[8px] border border-solid border-[#363a3f] bg-[#18191b] p-8">
            <Text className="mt-0 mb-6 text-[16px] font-semibold tracking-[-0.03em] text-[#edeef0]">
              Metamorph
            </Text>
            <Heading
              as="h1"
              className="mt-0 text-[21px] leading-[25px] font-semibold text-[#edeef0]"
            >
              Verify your email address
            </Heading>
            <Text className="text-[14px] leading-[20px] font-medium text-[#edeef0]">
              Hi {name},
            </Text>
            <Text className="text-[14px] leading-[20px] font-medium text-[#edeef0]">
              Confirm your email address to finish setting up your Metamorph account.
            </Text>
            <Section className="my-6">
              <Button
                href={url}
                className="box-border inline-block rounded-full bg-[#0090ff] px-5 py-3 text-center text-[12px] leading-[16px] font-semibold text-[#ffffff] no-underline"
              >
                Verify email address
              </Button>
            </Section>
            <Text className="text-[12px] leading-[16px] text-[#b0b4ba]">
              If the button does not work, copy and paste this link into your browser:{" "}
              <Link href={url} className="text-[#70b8ff] underline">
                {url}
              </Link>
            </Text>
            <Hr className="my-6 border-solid border-[#363a3f]" />
            <Text className="mb-0 text-[12px] leading-[16px] text-[#b0b4ba]">
              If you did not create a Metamorph account, you can safely ignore this email.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

VerificationEmail.PreviewProps = {
  name: "Ada Lovelace",
  url: "https://example.com/api/auth/verify-email?token=preview-token",
} satisfies VerificationEmailProps;

export default VerificationEmail;
