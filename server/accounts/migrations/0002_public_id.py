import uuid

from django.db import migrations, models


def fill_public_ids(apps, schema_editor):
    AccountProfile = apps.get_model("accounts", "AccountProfile")
    for profile in AccountProfile.objects.all():
        profile.public_id = uuid.uuid4()
        profile.save(update_fields=["public_id"])


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="accountprofile",
            name="public_id",
            field=models.UUIDField(null=True),
        ),
        migrations.RunPython(fill_public_ids, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="accountprofile",
            name="public_id",
            field=models.UUIDField(default=uuid.uuid4, editable=False, unique=True),
        ),
        migrations.CreateModel(
            name="DeletedAccount",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("public_id", models.UUIDField(unique=True)),
                ("email", models.EmailField(max_length=254)),
                ("deleted_at", models.DateTimeField(auto_now_add=True)),
            ],
        ),
    ]
