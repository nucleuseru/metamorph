import { PlopTypes } from "@turbo/gen";

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator("package", {
    description: "Adds a new package to the monorepo",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "What is the name of the package?",
        validate: (input: string) => {
          if (input.includes(" ")) {
            return "package name cannot include spaces";
          }
          if (!input) {
            return "package name is required";
          }
          return true;
        },
      },
    ],
    actions: [
      {
        type: "addMany",
        base: "templates/package",
        destination: "packages/{{name}}",
        templateFiles: "templates/package/**",
      },
    ],
  });
}
